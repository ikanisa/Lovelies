import { asyncSome } from './async-collections.ts';
import { ApiError, jsonBody, ok, stable, uuid, type AppContext, type Database } from './types.ts';
import { executeOperation, prepareOperation } from './operations.ts';
import { hasConsent } from './gallery.ts';
import { mediaHeld, requireOperator } from './operators.ts';
const DAY = 86400000;
export const retentionSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS retention_settings(id TEXT PRIMARY KEY CHECK(id='default'),version INTEGER NOT NULL CHECK(version>0),raw_days INTEGER NOT NULL CHECK(raw_days BETWEEN 1 AND 3650),preview_days INTEGER NOT NULL CHECK(preview_days BETWEEN 1 AND 3650),face_crop_days INTEGER NOT NULL CHECK(face_crop_days BETWEEN 1 AND 3650),free_cache_days INTEGER NOT NULL CHECK(free_cache_days BETWEEN 1 AND 3650),audit_days INTEGER NOT NULL CHECK(audit_days BETWEEN 2555 AND 36500),legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS asset_retention(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,raw_expires_at INTEGER NOT NULL,preview_expires_at INTEGER NOT NULL,legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS retention_jobs(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('raw','preview','profile')),binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),policy_version INTEGER NOT NULL,object_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','processing','failed','verified','blocked')),lease_token TEXT,lease_until INTEGER,created_at INTEGER NOT NULL,verified_at INTEGER,error_code TEXT,CHECK((asset_id IS NULL)=(kind='profile')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS retention_asset_job ON retention_jobs(asset_id,kind,object_version,policy_version) WHERE asset_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS retention_profile_job ON retention_jobs(subject_id,object_version,policy_version) WHERE kind='profile'`,
    `CREATE TABLE IF NOT EXISTS retention_objects(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES retention_jobs(id) ON DELETE CASCADE,bucket TEXT NOT NULL CHECK(bucket IN('PHOTOS','QUARANTINE')),object_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','failed','verified')),attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,verified_at INTEGER,UNIQUE(job_id,bucket,object_key))`,
    `CREATE INDEX IF NOT EXISTS retention_pending ON retention_jobs(status,created_at)`,
];
export async function initRetentionSchema(db: Database): Promise<void> { for (const sql of retentionSchemaStatements)
    (await db.run(sql)); }
type Policy = {
    id: string;
    version: number;
    raw_days: number;
    preview_days: number;
    face_crop_days: number;
    free_cache_days: number;
    audit_days: number;
    legal_hold: number;
    updated_at: number;
};
type Job = {
    id: string;
    subject_id: string;
    asset_id: string | null;
    kind: 'raw' | 'preview' | 'profile';
    binding_json: string;
    policy_version: number;
    object_version: string;
    status: string;
    lease_token: string | null;
    lease_until: number | null;
};
type PrivateObject = {
    bucket: 'PHOTOS' | 'QUARANTINE';
    object_key: string;
};
async function policy(ctx: AppContext): Promise<Policy> {
    (await ctx.db.run('INSERT OR IGNORE INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES(?,1,60,60,14,2,2555,0,?)', 'default', ctx.now()));
    return (await ctx.db.one<Policy>('SELECT * FROM retention_settings WHERE id=?', 'default'))!;
}
async function assetPolicy(ctx: AppContext, asset: any, p: Policy): Promise<any> {
    (await ctx.db.run('INSERT OR IGNORE INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,updated_at) VALUES(?,?,?,?)', asset.id, asset.created_at + p.raw_days * DAY, asset.created_at + p.preview_days * DAY, ctx.now()));
    return (await ctx.db.one<any>('SELECT * FROM asset_retention WHERE asset_id=?', asset.id))!;
}
async function keys(ctx: AppContext, asset: any, kind: 'raw' | 'preview'): Promise<PrivateObject[]> {
    const objects: PrivateObject[] = kind === 'raw' ? [{ bucket: 'QUARANTINE', object_key: asset.object_key }] : [];
    for (const row of (await ctx.db.all<{
        object_key: string;
    }>('SELECT object_key FROM renditions WHERE asset_id=?', asset.id)))
        objects.push({ bucket: 'PHOTOS', object_key: row.object_key });
    for (const row of (await ctx.db.all<{
        rendition_key: string;
    }>('SELECT rendition_key FROM processing_attempts WHERE asset_id=? AND rendition_key IS NOT NULL', asset.id)))
        objects.push({ bucket: 'PHOTOS', object_key: row.rendition_key });
    return [...new Map(objects.map(item => [item.bucket + ':' + item.object_key, item])).values()];
}
async function createJob(ctx: AppContext, p: Policy, subject: string, asset: string | null, kind: Job['kind'], version: string, binding: unknown, objects: PrivateObject[]): Promise<void> {
    const prior = (await ctx.db.one('SELECT id FROM retention_jobs WHERE subject_id=? AND kind=? AND object_version=? AND policy_version=? AND asset_id IS NOT DISTINCT FROM ?', subject, kind, version, p.version, asset));
    if (prior)
        return;
    const id = crypto.randomUUID();
    (await ctx.db.run("INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)", id, subject, asset, kind, stable(binding), p.version, version, ctx.now()));
    for (const item of objects)
        (await ctx.db.run("INSERT INTO retention_objects(id,job_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,'pending',?)", crypto.randomUUID(), id, item.bucket, item.object_key, ctx.now()));
}
async function hold(ctx: AppContext, job: Job, p: Policy): Promise<boolean> {
    if (p.legal_hold)
        return true;
    if (job.asset_id)
        return !!(await ctx.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=? AND legal_hold=1', job.asset_id)) || (await mediaHeld(ctx, job.subject_id, job.asset_id));
    return !!(await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=?', job.subject_id));
}
async function current(ctx: AppContext, id: string, lease?: string): Promise<{
    job: Job;
    binding: any;
}> {
    const job = (await ctx.db.one<Job>('SELECT * FROM retention_jobs WHERE id=?', id));
    if (!job || job.status !== 'processing' || lease && job.lease_token !== lease || job.lease_until === null || job.lease_until <= ctx.now())
        throw new ApiError(409, 'retention_job_changed');
    const p = (await policy(ctx));
    if (p.version !== job.policy_version || (await hold(ctx, job, p)))
        throw new ApiError(409, 'retention_authority_changed');
    const binding = JSON.parse(job.binding_json);
    if (job.asset_id) {
        const asset = (await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', job.asset_id)), rule = (await ctx.db.one<any>('SELECT * FROM asset_retention WHERE asset_id=?', job.asset_id));
        if (!asset || asset.owner_id !== job.subject_id || asset.version !== job.object_version || asset.object_key !== binding.object_key || asset.checksum_sha256 !== binding.checksum || !rule || rule.version !== binding.retention_version)
            throw new ApiError(409, 'retention_source_changed');
        if (job.kind === 'raw' && (asset.status !== 'expired' || asset.deleted_at !== binding.deleted_at || rule.raw_expires_at > ctx.now()))
            throw new ApiError(409, 'retention_authority_changed');
        if (job.kind === 'preview' && (asset.deleted_at !== null || rule.preview_expires_at > ctx.now()))
            throw new ApiError(409, 'retention_authority_changed');
    }
    else {
        const profile = (await ctx.db.one<any>('SELECT * FROM face_profiles WHERE account_id=?', job.subject_id));
        if (!profile || profile.revision !== job.object_version || profile.template_key !== binding.template_key || profile.template_digest !== binding.template_digest || profile.status !== 'revoked' || (await hasConsent(ctx, job.subject_id, 'face_authentication')) || (await hasConsent(ctx, job.subject_id, 'photo_matching')))
            throw new ApiError(409, 'retention_profile_changed');
    }
    return { job, binding };
}
async function snapshotExpired(ctx: AppContext, maximum: number): Promise<void> {
    const p = (await policy(ctx));
    if (p.legal_hold)
        return;
    // Metadata is paged before constructing object work. Existing grants are
    // retired synchronously before any external DELETE is attempted.
    const assets = (await ctx.db.all<any>(`SELECT a.* FROM assets a LEFT JOIN asset_retention r ON r.asset_id=a.id
    WHERE a.deleted_at IS NULL AND (coalesce(r.raw_expires_at,a.created_at+?)<=? OR coalesce(r.preview_expires_at,a.created_at+?)<=?)
    ORDER BY a.created_at,a.id LIMIT ?`, p.raw_days * DAY, ctx.now(), p.preview_days * DAY, ctx.now(), maximum));
    for (const asset of assets) {
        const rule = (await assetPolicy(ctx, asset, p));
        if (rule.legal_hold || (await mediaHeld(ctx, asset.owner_id, asset.id)))
            continue;
        const raw = rule.raw_expires_at <= ctx.now(), objects = (await keys(ctx, asset, raw ? 'raw' : 'preview'));
        // A live external writer must settle before the exact-key cleanup begins.
        if ((await asyncSome(objects, async (item) => (await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket=? AND object_key=? AND status='pending' LIMIT 1", item.bucket, item.object_key)))))
            continue;
        const deleted = raw ? ctx.now() : null;
        if (raw) {
            (await ctx.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", deleted, asset.id));
            (await ctx.db.run("UPDATE processing_attempts SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE asset_id=? AND status<>'completed'", asset.id));
            (await ctx.db.run("UPDATE photo_job_outbox SET status='cancelled' WHERE asset_id=?", asset.id));
            (await ctx.db.run("UPDATE candidates SET status='expired',version=? WHERE asset_id=?", crypto.randomUUID(), asset.id));
        }
        (await ctx.db.run("UPDATE renditions SET status='retired' WHERE asset_id=?", asset.id));
        (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE asset_id=?', ctx.now(), asset.id));
        (await ctx.db.run('DELETE FROM media_tickets WHERE asset_id=?', asset.id));
        (await ctx.db.run('DELETE FROM download_tickets WHERE asset_id=?', asset.id));
        (await createJob(ctx, p, asset.owner_id, asset.id, raw ? 'raw' : 'preview', asset.version, { object_key: asset.object_key, checksum: asset.checksum_sha256, retention_version: rule.version, deleted_at: deleted }, objects));
    }
    for (const profile of (await ctx.db.all<any>(`SELECT f.* FROM face_profiles f WHERE f.status='active'
    AND NOT EXISTS(SELECT 1 FROM consents c WHERE c.account_id=f.account_id AND c.purpose IN('face_authentication','photo_matching') AND c.status='granted' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?))
    ORDER BY f.account_id LIMIT ?`, ctx.now(), maximum))) {
        if (!profile.template_key || (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=?', profile.account_id)) || (await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket='PHOTOS' AND object_key=? AND status='pending'", profile.template_key)))
            continue;
        (await ctx.db.run("UPDATE face_profiles SET status='revoked',auth_enabled=0,auth_epoch=auth_epoch+1 WHERE account_id=?", profile.account_id));
        (await ctx.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', profile.account_id));
        (await ctx.db.run('UPDATE sessions SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?', ctx.now(), profile.account_id));
        (await ctx.db.run("UPDATE auth_challenges SET status='cancelled' WHERE account_id=?", profile.account_id));
        (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE recipient_id=?', ctx.now(), profile.account_id));
        (await ctx.db.run("UPDATE candidates SET status='expired',version=? WHERE recipient_id=?", crypto.randomUUID(), profile.account_id));
        (await createJob(ctx, p, profile.account_id, null, 'profile', profile.revision, { template_key: profile.template_key, template_digest: profile.template_digest }, [{ bucket: 'PHOTOS', object_key: profile.template_key }]));
    }
}
/** Trusted maintenance entry: bounded exact-key deletions. Completion requires
 * DELETE followed by absent HEAD under the same current metadata/hold lease. */
export async function runRetention(ctx: AppContext, maximum = 50): Promise<{
    verified: number;
    pending: number;
    failed: number;
}> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 200)
        throw new ApiError(400, 'retention_limit_invalid');
    (await ctx.db.transaction(async () => (await snapshotExpired(ctx, maximum))));
    let verified = 0, failed = 0;
    for (const row of (await ctx.db.all<Job>("SELECT * FROM retention_jobs WHERE status IN('pending','failed','processing') AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at,id LIMIT ?", ctx.now(), maximum))) {
        const lease = crypto.randomUUID();
        try {
            (await ctx.db.transaction(async () => {
                const actual = (await ctx.db.one<Job>('SELECT * FROM retention_jobs WHERE id=?', row.id));
                if (!actual || !['pending', 'failed', 'processing'].includes(actual.status) || actual.lease_until !== null && actual.lease_until > ctx.now())
                    throw new ApiError(409, 'retention_job_changed');
                const p = (await policy(ctx));
                if ((await hold(ctx, actual, p)))
                    throw new ApiError(503, 'retention_on_hold');
                // A hold pause may be released by a newer policy. The asset-specific
                // deadline, source, exact keys and purpose checks remain unchanged.
                (await ctx.db.run("UPDATE retention_jobs SET status='processing',policy_version=?,lease_token=?,lease_until=?,error_code=NULL WHERE id=?", p.version, lease, ctx.now() + 300000, row.id));
                (await current(ctx, row.id, lease));
            }));
            for (const item of (await ctx.db.all<any>("SELECT * FROM retention_objects WHERE job_id=? AND status<>'verified' ORDER BY id LIMIT 500", row.id))) {
                const check = async () => { (await current(ctx, row.id, lease)); if ((await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket=? AND object_key=? AND status='pending' LIMIT 1", item.bucket, item.object_key)))
                    throw new ApiError(503, 'retention_writer_unresolved'); };
                (await ctx.db.transaction(check));
                const bucket = ctx.env[item.bucket as PrivateObject['bucket']];
                await bucket.delete(item.object_key);
                (await ctx.db.transaction(check));
                const remains = await bucket.head(item.object_key);
                (await ctx.db.transaction(async () => { (await check()); if (remains)
                    throw new ApiError(503, 'retention_delete_unconfirmed'); (await ctx.db.run("UPDATE retention_objects SET status='verified',attempts=attempts+1,verified_at=? WHERE id=?", ctx.now(), item.id)); }));
            }
            (await ctx.db.transaction(async () => {
                (await current(ctx, row.id, lease));
                if ((await ctx.db.one("SELECT id FROM retention_objects WHERE job_id=? AND status<>'verified' LIMIT 1", row.id)))
                    return;
                // Keep a non-sensitive asset tombstone for exact immutable sharing and
                // financial receipt references. Profile templates have no foreign graph access.
                if (row.kind === 'profile')
                    (await ctx.db.run('DELETE FROM face_profiles WHERE account_id=? AND revision=?', row.subject_id, row.object_version));
                (await ctx.db.run("UPDATE retention_jobs SET status='verified',lease_token=NULL,lease_until=NULL,verified_at=? WHERE id=?", ctx.now(), row.id));
                verified++;
            }));
        }
        catch (error) {
            const code = error instanceof ApiError ? error.code : 'retention_storage_failed';
            const blocked = error instanceof ApiError && error.status === 409;
            (await ctx.db.run('UPDATE retention_jobs SET status=?,lease_token=NULL,lease_until=NULL,error_code=? WHERE id=? AND (lease_token=? OR lease_token IS NULL)', blocked ? 'blocked' : 'failed', code, row.id, lease));
            failed++;
        }
    }
    return { verified, pending: (await ctx.db.one<{
            n: number;
        }>("SELECT count(*) n FROM retention_jobs WHERE status<>'verified'"))!.n, failed };
}
function exact(body: Record<string, unknown>, keys: string[]): void { if (Object.keys(body).some(key => !keys.includes(key)))
    throw new ApiError(400, 'invalid_retention_input'); }
export async function handleRetention(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname, asset = /^\/admin\/assets\/([0-9a-f-]{36})\/retention$/i.exec(path);
    if (!['/admin/retention', '/admin/retention/run'].includes(path) && !asset)
        return null;
    const actor = await ctx.authenticate(request);
    (await requireOperator(ctx, actor, true));
    if (request.method === 'GET')
        return ok((await ctx.db.transaction(async () => { (await requireOperator(ctx, actor, true)); if (asset) {
            const item = (await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', uuid(asset[1])));
            if (!item)
                throw new ApiError(404, 'asset_not_found');
            return { asset_retention: (await assetPolicy(ctx, item, (await policy(ctx)))) };
        } return { policy: (await policy(ctx)), jobs: (await ctx.db.all('SELECT id,asset_id,kind,status,created_at,verified_at,error_code FROM retention_jobs ORDER BY created_at DESC,id LIMIT 100')) }; })));
    if (path === '/admin/retention/run') {
        if (request.method !== 'POST')
            throw new ApiError(405, 'method_not_allowed');
        const body = await jsonBody(request, 4096);
        exact(body, ['limit', 'operation_key']);
        const limit = body.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ApiError(400, 'retention_limit_invalid');
        const intent = await prepareOperation('retention.schedule', body, 'retention');
        const receipt = (await executeOperation(ctx, actor, intent, async () => { (await requireOperator(ctx, actor, true)); (await snapshotExpired(ctx, limit)); return { scheduled: true, operation_key: intent.key }; }));
        return ok(receipt); // Root's trusted alarm performs physical cleanup; never claim completion here.
    }
    if (request.method !== 'PATCH')
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 4096);
    exact(body, asset ? ['raw_expires_at', 'preview_expires_at', 'legal_hold', 'expected_version', 'operation_key'] : ['raw_days', 'preview_days', 'face_crop_days', 'free_cache_days', 'audit_days', 'legal_hold', 'expected_version', 'operation_key']);
    const intent = await prepareOperation('retention.update', { ...body, ...(asset ? { asset_id: uuid(asset[1]) } : {}) }, 'retention');
    return ok((await executeOperation(ctx, actor, intent, async () => {
        (await requireOperator(ctx, actor, true));
        if ((await ctx.db.one("SELECT id FROM retention_jobs WHERE status='processing' AND lease_until>? LIMIT 1", ctx.now())))
            throw new ApiError(409, 'retention_cleanup_in_progress');
        if (asset) {
            const item = (await ctx.db.one<any>('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL', uuid(asset[1])));
            if (!item)
                throw new ApiError(404, 'asset_not_found');
            const rule = (await assetPolicy(ctx, item, (await policy(ctx))));
            if (body.expected_version !== rule.version)
                throw new ApiError(409, 'retention_version_changed');
            for (const name of ['raw_expires_at', 'preview_expires_at'])
                if (Object.hasOwn(body, name)) {
                    const date = Date.parse(body[name]);
                    if (!Number.isSafeInteger(date) || date <= ctx.now())
                        throw new ApiError(400, 'invalid_retention_expiry');
                    (await ctx.db.run('UPDATE asset_retention SET ' + name + '=? WHERE asset_id=?', date, item.id));
                }
            if (Object.hasOwn(body, 'legal_hold')) {
                if (typeof body.legal_hold !== 'boolean')
                    throw new ApiError(400, 'invalid_retention_hold');
                (await ctx.db.run('UPDATE asset_retention SET legal_hold=? WHERE asset_id=?', body.legal_hold ? 1 : 0, item.id));
            }
            (await ctx.db.run('UPDATE asset_retention SET version=version+1,updated_at=? WHERE asset_id=?', ctx.now(), item.id));
            return { asset_retention: (await ctx.db.one('SELECT * FROM asset_retention WHERE asset_id=?', item.id)) };
        }
        const p = (await policy(ctx));
        if (body.expected_version !== p.version)
            throw new ApiError(409, 'retention_version_changed');
        for (const name of ['raw_days', 'preview_days', 'face_crop_days', 'free_cache_days', 'audit_days'])
            if (Object.hasOwn(body, name)) {
                if (!Number.isInteger(body[name]) || body[name] < (name === 'audit_days' ? 2555 : 1) || body[name] > (name === 'audit_days' ? 36500 : 3650))
                    throw new ApiError(400, 'invalid_retention_days');
                (await ctx.db.run('UPDATE retention_settings SET ' + name + '=? WHERE id=?', body[name], 'default'));
            }
        if (Object.hasOwn(body, 'legal_hold')) {
            if (typeof body.legal_hold !== 'boolean')
                throw new ApiError(400, 'invalid_retention_hold');
            (await ctx.db.run('UPDATE retention_settings SET legal_hold=? WHERE id=?', body.legal_hold ? 1 : 0, 'default'));
        }
        (await ctx.db.run("UPDATE retention_settings SET version=version+1,updated_at=? WHERE id='default'", ctx.now()));
        return { policy: (await policy(ctx)) };
    })));
}
export async function retentionPrivacyRows(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const rows = { asset_retention: (await ctx.db.all('SELECT r.asset_id,r.raw_expires_at,r.preview_expires_at,r.legal_hold FROM asset_retention r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=? ORDER BY r.asset_id LIMIT 25001', subject)), retention_jobs: (await ctx.db.all('SELECT id,asset_id,kind,status,created_at,verified_at,error_code FROM retention_jobs WHERE subject_id=? ORDER BY created_at,id LIMIT 25001', subject)) };
    if (Object.values(rows).some(items => items.length > 25000))
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
/** Root captures these exact job keys into request-authorized privacy cleanup
 * before deleting the metadata; no foreign profile keys or bucket listing. */
export async function retentionPrivateKeys(db: Database, subject: string): Promise<PrivateObject[]> {
    return (await db.all<PrivateObject>('SELECT DISTINCT o.bucket,o.object_key FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE j.subject_id=?', subject));
}
export async function eraseRetentionSubject(db: Database, subject: string): Promise<void> {
    (await db.run('DELETE FROM retention_jobs WHERE subject_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject, subject));
    (await db.run('DELETE FROM asset_retention WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
}
/** Next maintenance horizon is computed from persisted metadata, not a cron
 * promise. Root may cap the returned deadline for bounded housekeeping. */
export async function nextRetentionAt(ctx: AppContext): Promise<number | null> {
    const p = (await policy(ctx));
    if (p.legal_hold)
        return null;
    const asset = (await ctx.db.one<{
        deadline: number | null;
    }>(`SELECT min(min(coalesce(r.raw_expires_at,a.created_at+?),CASE WHEN EXISTS(SELECT 1 FROM renditions ready WHERE ready.asset_id=a.id AND ready.status='ready') THEN coalesce(r.preview_expires_at,a.created_at+?) ELSE coalesce(r.raw_expires_at,a.created_at+?) END)) deadline
    FROM assets a LEFT JOIN asset_retention r ON r.asset_id=a.id WHERE a.deleted_at IS NULL AND coalesce(r.legal_hold,0)=0
    AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.asset_id=a.id OR h.subject_id=a.owner_id))`, p.raw_days * DAY, p.preview_days * DAY, p.raw_days * DAY));
    const profile = (await ctx.db.one<{
        deadline: number | null;
    }>("SELECT min(c.expires_at) deadline FROM consents c JOIN face_profiles f ON f.account_id=c.account_id AND f.status='active' WHERE c.status='granted' AND c.revoked_at IS NULL AND c.purpose IN('face_authentication','photo_matching') AND c.expires_at>?", ctx.now()));
    const pending = (await ctx.db.one("SELECT id FROM retention_jobs WHERE status IN('pending','failed','processing') LIMIT 1"));
    const deadlines = [asset?.deadline, profile?.deadline, pending ? ctx.now() + 60000 : null].filter((value): value is number => value !== null && value !== undefined);
    return deadlines.length ? Math.max(ctx.now() + 60000, Math.min(...deadlines)) : null;
}
