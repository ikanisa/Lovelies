import { asyncSome } from './async-collections.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type AppContext, type Binding, type Database } from './types.ts';
import { executeOperation, prepareOperation, retiredOperationInput, retiredOperationResponse } from './operations.ts';
import { hasConsent } from './gallery.ts';
import { mediaHeld, requireOperator } from './operators.ts';
import { AUDIENCE_POLICY } from './audience.ts';
import { INACTIVE_PROFILE_FACT, inactiveProfileOperationVersion } from './face-profile.ts';
const DAY = 86400000;
type InactiveKind = 'lifecycle' | 'job';
type InactiveSource = { id: string; at: number };
type InactiveSnapshot = { source: any; subject: string; key: string; at: number; policy: Policy; cleanup: any; operations: any[]; objects: any[]; writers: any[] };
export const retentionSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS retention_settings(id TEXT PRIMARY KEY CHECK(id='default'),version INTEGER NOT NULL CHECK(version>0),raw_days INTEGER NOT NULL CHECK(raw_days BETWEEN 1 AND 3650),preview_days INTEGER NOT NULL CHECK(preview_days BETWEEN 1 AND 3650),face_crop_days INTEGER NOT NULL CHECK(face_crop_days BETWEEN 1 AND 3650),free_cache_days INTEGER NOT NULL CHECK(free_cache_days BETWEEN 1 AND 3650),audit_days INTEGER NOT NULL CHECK(audit_days BETWEEN 1 AND 30),legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN(0,1)),updated_at INTEGER NOT NULL)`,
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
    (await ctx.db.run('INSERT OR IGNORE INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES(?,1,60,60,14,2,30,0,?)', 'default', ctx.now()));
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
    const metadataFailures = await pruneInactiveProfileMetadata(ctx, maximum);
    (await ctx.db.transaction(async () => { await pruneRetainedMetadata(ctx, maximum); await snapshotExpired(ctx, maximum); }));
    let verified = 0, failed = metadataFailures;
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
                if (row.kind === 'raw') {
                    await ctx.db.run('UPDATE assets SET title=NULL,captured_at=NULL,width=NULL,height=NULL WHERE id=?',row.asset_id);
                    await ctx.db.run("UPDATE processing_attempts SET profiles_json='[]',matches_json='[]',processor_nonce=NULL,rendition_key=NULL WHERE asset_id=? AND status<>'running'",row.asset_id);
                }
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
// Inactive reference reconciliation keeps exact keys only while cleanup or
// recovery still needs them. Minimal completion facts carry no object address.
const INACTIVE_JOB_FACT = 'lovelies-inactive-profile-job-completion-v1';
const canonicalID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const canonicalReference = (key: unknown, subject: string, profile?: string) => {
    if (typeof key !== 'string') return false;
    const pieces = key.split('/');
    return pieces.length === 4 && pieces[0] === 'registered-face' && pieces[1] === subject &&
        canonicalID(pieces[2]) && canonicalID(pieces[3]) && (profile === undefined || pieces[2] === profile);
};
async function inactiveSources(ctx: AppContext, kind: InactiveKind, maximum: number): Promise<InactiveSource[]> {
    return ctx.db.transaction(async () => {
        const p = await policy(ctx);
        if (p.legal_hold) return [];
        const entity = 'inactive-profile-' + kind + '-v1';
        const cursor = await ctx.db.one<{last_at: number | null; last_id: string | null}>(
            "SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?", entity);
        const after = cursor?.last_at ?? null, id = cursor?.last_id ?? null;
        if ((after === null) !== (id === null) || after !== null && (!integer(after) || !canonicalID(id)))
            throw new ApiError(503, 'retention_cursor_invalid');
        const relation = kind === 'lifecycle' ?
            "face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id WHERE c.status='verified'" :
            "retention_jobs r WHERE r.kind='profile' AND r.status='verified' AND json_extract(r.binding_json,'$.template_key') IS NOT NULL";
        const date = kind === 'lifecycle' ? 'c.created_at' : 'r.created_at', key = kind === 'lifecycle' ? 'r.cleanup_id' : 'r.id';
        const rows = await ctx.db.all<InactiveSource>(`SELECT ${key} id,${date} at FROM ${relation} AND ${date}<=?
            ${after === null ? '' : `AND (${date}>? OR (${date}=? AND ${key}>?))`}
            ORDER BY ${date},${key} LIMIT ?`, ctx.now() - p.face_crop_days * DAY,
            ...(after === null ? [] : [after, after, id]), maximum);
        const last = rows.at(-1);
        await ctx.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id",
            entity, last?.at ?? null, last?.id ?? null);
        return rows;
    });
}
async function inactiveSnapshot(ctx: AppContext, kind: InactiveKind, candidate: InactiveSource): Promise<InactiveSnapshot | null> {
    const p = await policy(ctx);
    if (p.legal_hold || !integer(candidate.at) || candidate.at > ctx.now() - p.face_crop_days * DAY) return null;
    const source = await ctx.db.one<any>(kind === 'lifecycle' ?
        'SELECT * FROM face_profile_retirements WHERE cleanup_id=?' : 'SELECT * FROM retention_jobs WHERE id=?', candidate.id);
    if (!source) return null;
    const subject = kind === 'lifecycle' ? source.account_id : source.subject_id;
    if (!canonicalID(subject)) return null;
    let key: string, cleanup: any = null, operations: any[] = [], objects: any[] = [];
    if (kind === 'lifecycle') {
        key = source.template_key;
        cleanup = await ctx.db.one<any>('SELECT * FROM cleanup_intents WHERE id=?', source.cleanup_id);
        if (!canonicalReference(key, subject, source.profile_id) || !canonicalID(source.profile_revision) || !/^[0-9a-f]{64}$/.test(source.template_digest) ||
            !cleanup || cleanup.request_id !== null || cleanup.subject_id !== subject || cleanup.bucket !== 'PHOTOS' || cleanup.object_key !== key ||
            cleanup.status !== 'verified' || cleanup.created_at !== candidate.at || !integer(cleanup.verified_at) || cleanup.verified_at < candidate.at || cleanup.verified_at > ctx.now()) return null;
        operations = await ctx.db.all<any>('SELECT * FROM face_profile_operations WHERE cleanup_id=? ORDER BY account_id,operation_key LIMIT 201', source.cleanup_id);
        if (operations.length > 200) return null;
        const own = operations.filter(row => row.account_id === subject && row.operation_key === source.operation_key);
        if (source.operation_key.startsWith('audience:')) {
            if (operations.length !== 0) return null;
        } else if (own.length !== 1 || !canonicalID(source.operation_key)) return null;
        for (const op of operations) {
            const terminal = op.action === 'replace' ? op.state === 'completed' : ['pause', 'withdraw_authentication', 'remove'].includes(op.action) && op.state === 'applied';
            if (op.account_id !== subject || !canonicalID(op.operation_key) || !terminal || !integer(op.created_at) || op.created_at > candidate.at ||
                !/^[0-9a-f]{64}$/.test(op.input_hash) || await ctx.db.one("SELECT id FROM retention_jobs WHERE subject_id=? AND kind='profile' AND object_version=? LIMIT 1", subject, inactiveProfileOperationVersion(op.operation_key))) return null;
        }
        if (await ctx.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE template_key=? AND cleanup_id<>? LIMIT 1', key, source.cleanup_id) ||
            await ctx.db.one('SELECT id FROM retention_objects WHERE bucket=\'PHOTOS\' AND object_key=? LIMIT 1', key)) return null;
    } else {
        let binding: any;
        try { binding = JSON.parse(source.binding_json); } catch { return null; }
        if (!object(binding) || !shape(binding, ['template_key', 'template_digest']) || !canonicalReference(binding.template_key, subject) ||
            typeof binding.template_digest !== 'string' || !/^[0-9a-f]{64}$/.test(binding.template_digest) || !canonicalID(source.object_version) ||
            source.kind !== 'profile' || source.asset_id !== null || source.status !== 'verified' || source.created_at !== candidate.at ||
            source.lease_token !== null || source.lease_until !== null || !integer(source.verified_at) || source.verified_at < candidate.at || source.verified_at > ctx.now()) return null;
        key = binding.template_key;
        objects = await ctx.db.all<any>('SELECT * FROM retention_objects WHERE job_id=? ORDER BY id LIMIT 201', source.id);
        if (objects.length !== 1 || objects[0].bucket !== 'PHOTOS' || objects[0].object_key !== key || objects[0].status !== 'verified' ||
            !integer(objects[0].verified_at) || objects[0].verified_at < objects[0].created_at || objects[0].verified_at > ctx.now() ||
            await ctx.db.one('SELECT id FROM retention_objects WHERE bucket=\'PHOTOS\' AND object_key=? AND job_id<>? LIMIT 1', key, source.id) ||
            await ctx.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE template_key=? LIMIT 1', key)) return null;
    }
    // Any current reference, unresolved privacy review, hold or newer/foreign
    // writer makes this historical address necessary until reconciled.
    if (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1', subject) ||
        await ctx.db.one('SELECT id FROM face_profiles WHERE template_key=? LIMIT 1', key) ||
        await ctx.db.one("SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND status IN('pending_approval','approved','queued','processing','failed') LIMIT 1", subject) ||
        await ctx.db.one("SELECT id FROM auth_challenges WHERE account_id=? AND status IN('pending','verifying') AND used_at IS NULL AND expires_at>? LIMIT 1", subject, ctx.now())) return null;
    const copies = await ctx.db.all<any>("SELECT * FROM cleanup_intents WHERE bucket='PHOTOS' AND object_key=? ORDER BY id LIMIT 201", key);
    if (kind === 'lifecycle' ? copies.length !== 1 || copies[0].id !== cleanup.id : copies.length !== 0) return null;
    const writers = await ctx.db.all<any>("SELECT * FROM media_write_intents WHERE bucket='PHOTOS' AND object_key=? ORDER BY id LIMIT 201", key);
    if (writers.length > 200 || writers.some(row => row.account_id !== subject || row.status !== 'settled' || !integer(row.created_at) || row.created_at > candidate.at ||
        !integer(row.settled_at) || row.settled_at < row.created_at || row.settled_at > ctx.now())) return null;
    return {source, subject, key, at: candidate.at, policy: p, cleanup, operations, objects, writers};
}
/** HEAD runs outside the global SQL lock. The exact snapshot is checked again
 * after the await; unsupported/new writer or hold state preserves all old facts.
 * This phase never deletes an object or relabels an unknown key as completed. */
export async function pruneInactiveProfileMetadata(ctx: AppContext, maximum = 50): Promise<number> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 200) throw new ApiError(400, 'retention_limit_invalid');
    const kinds = await ctx.db.transaction(async (): Promise<InactiveKind[]> => {
        if ((await policy(ctx)).legal_hold) return [];
        const entity = 'inactive-profile-class-v1';
        const cursor = await ctx.db.one<{last_at: number | null; last_id: string | null}>(
            "SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?", entity);
        if (cursor && (!integer(cursor.last_at) || cursor.last_id !== 'lifecycle' && cursor.last_id !== 'job'))
            throw new ApiError(503, 'retention_cursor_invalid');
        const first: InactiveKind = cursor?.last_id === 'lifecycle' ? 'job' : 'lifecycle';
        await ctx.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id",
            entity, ctx.now(), first);
        return [first, first === 'lifecycle' ? 'job' : 'lifecycle'];
    });
    const budget = Math.min(maximum, 20);
    let failures = 0, remaining = budget;
    for (const [index, kind] of kinds.entries()) {
        if (!remaining) break;
        // Each source class gets a turn even under a continuously growing or
        // held backlog. With limit=1, the durable class cursor alternates it.
        const candidates = await inactiveSources(ctx, kind, index === 0 ? Math.ceil(budget / 2) : remaining);
        remaining -= candidates.length;
        for (const candidate of candidates) {
            try {
                const before = await ctx.db.transaction(() => inactiveSnapshot(ctx, kind, candidate));
                if (!before) continue;
                if (await ctx.env.PHOTOS.head(before.key)) { failures++; continue; }
                await ctx.db.transaction(async () => {
                    const actual = await inactiveSnapshot(ctx, kind, candidate);
                    if (!actual || stable(actual) !== stable(before)) return;
                    if (kind === 'lifecycle') {
                        for (const op of actual.operations) {
                            const binding = {protocol: INACTIVE_PROFILE_FACT, account_id: actual.subject, operation_key: op.operation_key,
                                action: op.action, state: op.state, input_hash: op.input_hash, retired_at: actual.at};
                            await ctx.db.run("INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at,verified_at) VALUES(?,?,NULL,'profile',?,?,?,'verified',?,?)",
                                crypto.randomUUID(), actual.subject, stable(binding), actual.policy.version, inactiveProfileOperationVersion(op.operation_key), actual.at, actual.cleanup.verified_at);
                            await ctx.db.run('UPDATE face_profile_operations SET cleanup_id=NULL WHERE account_id=? AND operation_key=? AND cleanup_id=?', op.account_id, op.operation_key, actual.cleanup.id);
                        }
                        await ctx.db.run('DELETE FROM face_profile_retirements WHERE cleanup_id=?', actual.source.cleanup_id);
                        await ctx.db.run('DELETE FROM cleanup_intents WHERE id=?', actual.cleanup.id);
                    } else {
                        await ctx.db.run('DELETE FROM retention_objects WHERE job_id=?', actual.source.id);
                        await ctx.db.run('UPDATE retention_jobs SET binding_json=? WHERE id=?', stable({protocol: INACTIVE_JOB_FACT, account_id: actual.subject,
                            object_version: actual.source.object_version, retired_at: actual.at}), actual.source.id);
                    }
                    for (const writer of actual.writers) await ctx.db.run('DELETE FROM media_write_intents WHERE id=?', writer.id);
                });
            } catch { failures++; }
        }
    }
    return failures;
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
                if (!Number.isInteger(body[name]) || body[name] < 1 || body[name] > (name === 'audit_days' ? 30 : 3650))
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
    const lifecycleMetadata = await ctx.db.one<{deadline: number | null}>(`SELECT min(c.created_at)+? deadline FROM face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id
        WHERE c.status='verified' AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=r.account_id)`, p.face_crop_days * DAY);
    const jobMetadata = await ctx.db.one<{deadline: number | null}>(`SELECT min(j.created_at)+? deadline FROM retention_jobs j
        WHERE j.kind='profile' AND j.status='verified' AND json_extract(j.binding_json,'$.template_key') IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=j.subject_id)`, p.face_crop_days * DAY);
    const deadlines = [asset?.deadline, profile?.deadline, lifecycleMetadata?.deadline, jobMetadata?.deadline, pending ? ctx.now() + 60000 : null].filter((value): value is number => value !== null && value !== undefined);
    return deadlines.length ? Math.max(ctx.now() + 60000, Math.min(...deadlines)) : null;
}

type StoredOperation = {
    actor_id: string; source: string; operation_key: string; action: string;
    payload_hash: string; payload_json: string; response_json: string; created_at: number;
};
type OperationLink = {
    sql: string; bindings: string[]; subjects: string[]; entity: string;
    valid: (row: StoredOperation, input: Record<string, unknown>, result: Record<string, any>) => boolean | 'other' | Promise<boolean | 'other'>;
    continuation?: { generation: string; currentGeneration: () => Promise<string | null> };
};
function object(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const shape = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = (value: unknown, minimum = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const textValue = (value: unknown, maximum: number, minimum = 0) => typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const optionalText = (value: Record<string, unknown>, key: string, maximum: number) => !Object.hasOwn(value, key) || value[key] === null || textValue(value[key], maximum);
const normalizedText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null;
const dateText = (value: unknown) => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const evidence = (input: Record<string, unknown>) => typeof input.evidence_method === 'string' && ['independent_live_review', 'independent_document_review'].includes(input.evidence_method) && typeof input.evidence_reference === 'string' && /^[A-Za-z0-9._:-]{16,128}$/.test(input.evidence_reference);
function supportOperation(row: StoredOperation, input: Record<string, unknown>, result: Record<string, any>, support: any): boolean {
    if (row.action === 'support.create') return shape(input, ['subject', 'details', 'operation_key']) && textValue(input.subject, 160, 3) && textValue(input.details, 4000, 5) &&
        normalizedText(input.subject) === support.subject && normalizedText(input.details) === support.details &&
        row.actor_id === support.account_id && shape(result, ['id', 'status', 'revision']) && result.id === support.id && result.status === 'open' && result.revision === 1;
    if (!['support.start', 'support.approve', 'support.reject', 'support.close'].includes(row.action) ||
        !shape(input, ['expected_revision', 'operation_key', 'request_id'], ['review_notes', 'sla_due_at']) || !integer(input.expected_revision, 1) || input.request_id !== support.id ||
        !optionalText(input, 'review_notes', 4000) || Object.hasOwn(input, 'sla_due_at') && input.sla_due_at !== null && (typeof input.sla_due_at !== 'string' || !Number.isFinite(Date.parse(input.sla_due_at))) ||
        !shape(result, ['support_request']) || !object(result.support_request)) return false;
    const saved = result.support_request, start = row.action === 'support.start', close = row.action === 'support.close';
    return shape(saved, ['id', 'account_id', 'subject', 'details', 'status', 'category', 'assigned_to', 'sla_due_at', 'review_outcome', 'review_notes', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at', 'revision']) &&
        saved.id === support.id && saved.account_id === support.account_id && saved.subject === support.subject && saved.details === support.details && textValue(saved.subject, 160, 3) && textValue(saved.details, 4000, 5) && saved.category === 'general_support' &&
        saved.status === (start ? 'under_review' : close ? 'closed' : 'resolved') && saved.assigned_to === row.actor_id && saved.reviewed_by === (start ? null : row.actor_id) &&
        saved.review_outcome === (start || close ? null : row.action === 'support.approve' ? 'approved' : 'rejected') &&
        saved.review_notes === normalizedText(input.review_notes) && integer(saved.sla_due_at) && integer(saved.created_at) && integer(saved.updated_at) && saved.created_at <= saved.updated_at &&
        (start ? saved.reviewed_at === null : integer(saved.reviewed_at)) && saved.revision === Number(input.expected_revision) + 1;
}
function guardianOperation(row: StoredOperation, input: Record<string, unknown>, result: Record<string, any>, guardian: any): boolean {
    if (!shape(result, ['request_id']) || result.request_id !== guardian.id) return false;
    if (row.action === 'guardian.create') return row.actor_id === guardian.child_account_id && shape(input, ['expected_version', 'policy_version', 'operation_key']) && integer(input.expected_version, 1) && input.policy_version === guardian.policy_version;
    if (input.target_id !== guardian.id || !integer(input.expected_revision, 1)) return false;
    if (row.action === 'guardian.withdraw') return [guardian.child_account_id, guardian.guardian_account_id].includes(row.actor_id) && shape(input, ['expected_revision', 'operation_key', 'target_id']);
    if (input.policy_version !== guardian.policy_version) return false;
    if (row.action === 'guardian.claim') return row.actor_id === guardian.guardian_account_id && shape(input, ['expected_revision', 'policy_version', 'relationship_attested', 'purposes', 'operation_key', 'target_id']) && input.relationship_attested === true &&
        Array.isArray(input.purposes) && input.purposes.length > 0 && input.purposes.length <= 3 && new Set(input.purposes).size === input.purposes.length && input.purposes.every(value => ['face_authentication', 'photo_matching', 'photo_processing'].includes(value));
    return row.action === 'guardian.review' && row.actor_id === guardian.reviewed_by && row.actor_id !== guardian.child_account_id && row.actor_id !== guardian.guardian_account_id &&
        shape(input, ['expected_revision', 'policy_version', 'decision', 'evidence_method', 'evidence_reference', 'operation_key', 'target_id'], ['adult_verified', 'parental_responsibility_verified']) &&
        evidence(input) && typeof input.decision === 'string' && ['approve', 'reject'].includes(input.decision) &&
        (!Object.hasOwn(input, 'adult_verified') || typeof input.adult_verified === 'boolean') && (!Object.hasOwn(input, 'parental_responsibility_verified') || typeof input.parental_responsibility_verified === 'boolean') &&
        (input.decision !== 'approve' || input.adult_verified === true && input.parental_responsibility_verified === true);
}
function adultOperation(input: Record<string, unknown>, result: Record<string, any>, review: any): boolean {
    return shape(input, ['expected_version', 'policy_version', 'evidence_method', 'evidence_reference', 'adult_verified', 'operation_key', 'target_id']) && integer(input.expected_version, 1) &&
        input.policy_version === AUDIENCE_POLICY && input.adult_verified === true && evidence(input) && input.evidence_method === review.evidence_method && input.evidence_reference === review.evidence_reference && input.target_id === review.account_id &&
        shape(result, ['account_id']) && result.account_id === review.account_id;
}
async function adultOperationLink(ctx: AppContext, input: Record<string, unknown>, result: Record<string, any>, review: any): Promise<boolean | 'other'> {
    if (adultOperation(input, result, review)) return true;
    if (!evidence(input)) return false;
    // A supported adult/minor/adult cycle can create a different review for the
    // same account and reviewer. Its intact receipt belongs to that exact unique
    // tuple, even when it is too recent for retention. Never retire it here.
    const others = await ctx.db.all<any>('SELECT * FROM audience_adult_reviews WHERE account_id=? AND reviewed_by=? AND evidence_method=? AND evidence_reference=? LIMIT 2',
        review.account_id, review.reviewed_by, String(input.evidence_method), String(input.evidence_reference));
    return others.length === 1 && others[0].id !== review.id && adultOperation(input, result, others[0]) ? 'other' : false;
}
async function adultReceiptGeneration(ctx: AppContext, id: string): Promise<string | null> {
    const review = await ctx.db.one<any>('SELECT id,account_id,reviewed_by,evidence_method,evidence_reference,created_at FROM audience_adult_reviews WHERE id=?', id);
    if (!review) return null;
    const audience = await ctx.db.one<{ version: number }>('SELECT version FROM account_audience WHERE account_id=?', review.account_id);
    return digest(stable({ review, audience_version: audience?.version ?? null }));
}
function privacyOperation(row: StoredOperation, input: Record<string, unknown>, result: Record<string, any>, request: any): boolean {
    if (!object(result.privacy_request) || result.privacy_request.id !== request.id || result.privacy_request.request_type !== request.request_type) return false;
    const saved = result.privacy_request;
    if (row.action === 'privacy.request.' + request.request_type) {
        if (!shape(input, ['operation_key'], request.request_type === 'delete' ? ['reason', 'status_token_hash'] : ['reason']) || !optionalText(input, 'reason', 1000) || row.actor_id !== request.requested_by ||
            saved.subject_user_id !== request.subject_id || saved.requested_by !== request.requested_by || saved.status !== 'pending_approval' || saved.reason !== normalizedText(input.reason)) return false;
        if (!Object.hasOwn(input, 'status_token_hash')) return shape(result, ['privacy_request']) && shape(saved, ['id', 'request_type', 'subject_user_id', 'requested_by', 'status', 'reason']);
        return typeof input.status_token_hash === 'string' && /^[0-9a-f]{64}$/.test(input.status_token_hash) &&
            shape(result, ['protocol', 'source', 'operation_key', 'privacy_request', 'deletion_status', 'deletion_completed', 'request_expires_at', 'request_expired']) &&
            result.protocol === 'lovelies-account-deletion-v1' && result.source === 'privacy' && result.operation_key === row.operation_key && result.deletion_completed === false && result.request_expired === false && dateText(result.request_expires_at) &&
            object(result.deletion_status) && shape(result.deletion_status, ['expires_at']) && dateText(result.deletion_status.expires_at) &&
            shape(saved, ['id', 'request_type', 'status', 'created_at', 'reviewed_at', 'completed_at', 'failure_code', 'subject_user_id', 'requested_by', 'reason']) && dateText(saved.created_at) && saved.reviewed_at === null && saved.completed_at === null && saved.failure_code === null;
    }
    return ['privacy.review.approve', 'privacy.review.reject'].includes(row.action) && shape(input, ['operation_key', 'request_id'], ['reason']) && input.request_id === request.id &&
        optionalText(input, 'reason', 1000) && (row.action !== 'privacy.review.reject' || textValue(input.reason, 1000, 1)) && row.actor_id === request.reviewed_by &&
        shape(result, ['privacy_request', 'delivery_confirmed']) && result.delivery_confirmed === false && shape(saved, ['id', 'request_type', 'status', 'reviewed_by', 'reviewed_at']) &&
        saved.status === (row.action === 'privacy.review.approve' ? 'queued' : 'rejected') && saved.reviewed_by === row.actor_id && dateText(saved.reviewed_at);
}
/** A terminal source is not permission to erase an outstanding writer, cleanup,
 * hold or delivery obligation. No external object or queue row is changed here. */
async function operationRetirementBlocked(ctx: AppContext, subjects: string[], entity: string): Promise<boolean> {
    for (const subject of new Set(subjects)) {
        if (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1', subject) ||
            await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1", subject) ||
            await ctx.db.one("SELECT id FROM cleanup_intents WHERE subject_id=? AND status<>'verified' LIMIT 1", subject) ||
            await ctx.db.one('SELECT id FROM outbox WHERE account_id=? AND delivered_at IS NULL AND cancelled_at IS NULL LIMIT 1', subject)) return true;
    }
    return !!(await ctx.db.one('SELECT id FROM outbox WHERE entity_id=? AND delivered_at IS NULL AND cancelled_at IS NULL LIMIT 1', entity) ||
        await ctx.db.one("SELECT id FROM job_queue WHERE category='privacy' AND json_extract(payload_json,'$.request_id')=? AND state<>'completed' LIMIT 1", entity) ||
        await ctx.db.one("SELECT j.notification_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE n.entity_id=? AND j.status IN('queued','dispatched','ambiguous') LIMIT 1", entity) ||
        await ctx.db.one("SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.entity_id=? AND d.status IN('queued','dispatching','ambiguous') LIMIT 1", entity));
}
/** Retire only positively bound, intact receipts. The caller owns the source
 * transaction and retains that source until all matching full copies are gone.
 * A shared budget bounds updates across every record class in this invocation. */
async function retireLinkedOperations(ctx: AppContext, link: OperationLink, budget: { left: number }): Promise<boolean> {
    if (await operationRetirementBlocked(ctx, link.subjects, link.entity)) return false;
    const allowance = Math.min(budget.left, 20);
    if (!allowance) return false;
    let after: { at: number; key: string } | null = null;
    if (link.continuation) {
        const cursor = await ctx.db.one<{ last_at: number | null; last_id: string | null }>('SELECT last_at,last_id FROM retention_scan_cursors WHERE scan=? AND entity_id=?', 'adult', link.entity);
        if (cursor && (cursor.last_at !== null || cursor.last_id !== null)) {
            let checkpoint: unknown;
            try { checkpoint = JSON.parse(cursor.last_id ?? ''); } catch { throw new ApiError(503, 'retention_cursor_invalid'); }
            if (!integer(cursor.last_at) || !object(checkpoint) || !shape(checkpoint, ['protocol', 'generation', 'operation_key']) || checkpoint.protocol !== 'lovelies-retention-receipts-v1' ||
                typeof checkpoint.generation !== 'string' || !/^[0-9a-f]{64}$/.test(checkpoint.generation) || typeof checkpoint.operation_key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(checkpoint.operation_key))
                throw new ApiError(503, 'retention_cursor_invalid');
            if (checkpoint.generation === link.continuation.generation) after = { at: Number(cursor.last_at), key: checkpoint.operation_key };
        }
    }
    const rows = await ctx.db.all<StoredOperation>(`SELECT o.actor_id,o.source,o.operation_key,o.action,o.payload_hash,o.payload_json,o.response_json,o.created_at
      FROM operations o WHERE (${link.sql}) AND (o.payload_json<>? OR o.response_json<>?)
      ${after ? 'AND (o.created_at>? OR (o.created_at=? AND o.operation_key>?))' : ''}
      ORDER BY o.created_at,o.actor_id,o.source,o.operation_key LIMIT ?`, ...link.bindings, retiredOperationInput, retiredOperationResponse, ...(after ? [after.at, after.at, after.key] : []), allowance + 1);
    const selected = rows.slice(0, allowance);
    const retire: StoredOperation[] = [];
    for (const row of selected) {
        let input: unknown, result: unknown;
        try { input = JSON.parse(row.payload_json); result = JSON.parse(row.response_json); } catch { return false; }
        if (!integer(row.created_at) || !object(input) || !object(result) || typeof input.operation_key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.operation_key) || input.operation_key !== row.operation_key ||
            await digest(stable({ action: row.action, source: row.source, payload: input })) !== row.payload_hash) return false;
        const classification = await link.valid(row, input, result);
        if (!classification) return false;
        const related = await ctx.db.all<{ subject_id: string }>('SELECT subject_id FROM operation_subjects WHERE actor_id=? AND source=? AND operation_key=? LIMIT 201', row.actor_id, row.source, row.operation_key);
        if (related.length > 200 || !link.subjects.some(subject => related.some(item => item.subject_id === subject)) ||
            await operationRetirementBlocked(ctx, [row.actor_id, ...related.map(item => item.subject_id)], link.entity)) return false;
        if (classification !== 'other') retire.push(row);
    }
    for (const row of retire) {
        await ctx.db.run('UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source=? AND operation_key=? AND payload_hash=? AND payload_json=? AND response_json=?',
            retiredOperationInput, retiredOperationResponse, row.actor_id, row.source, row.operation_key, row.payload_hash, row.payload_json, row.response_json);
        const current = await ctx.db.one<{payload_json: string; response_json: string}>('SELECT payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', row.actor_id, row.source, row.operation_key);
        if (current?.payload_json !== retiredOperationInput || current.response_json !== retiredOperationResponse)
            throw new ApiError(409, 'retention_operation_changed');
        budget.left--;
    }
    const complete = rows.length === selected.length;
    if (link.continuation) {
        // Other intact review receipts remain unchanged. Save our proof of that
        // bounded prefix instead of repeatedly scanning the same recent copies.
        // All adult-review publications increment the account audience version
        // atomically with source+receipt, invalidating even a backdated prefix.
        if (await link.continuation.currentGeneration() !== link.continuation.generation) return false;
        if (!complete) {
            const last = selected.at(-1)!;
            await ctx.db.run('INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES(?,?,?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id',
                'adult', link.entity, last.created_at, stable({ protocol: 'lovelies-retention-receipts-v1', generation: link.continuation.generation, operation_key: last.operation_key }));
        }
    }
    return complete;
}
type RetentionScan = 'support' | 'guardian' | 'adult' | 'privacy';
/** Persist the last examined source, including blocked records, across isolates.
 * An empty bounded query proves exhaustion; only then does that class wrap.
 * Cursor and source/receipt work commit or roll back in the same transaction. */
async function terminalScan(ctx: AppContext, scan: RetentionScan, fromWhere: string, order: string, bindings: Binding[], maximum: number): Promise<any[]> {
    const cursor = await ctx.db.one<{ last_at: number | null; last_id: string | null }>("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan=? AND entity_id=''", scan);
    const lastAt = cursor?.last_at ?? null, lastID = cursor?.last_id ?? null, continuation = lastAt !== null;
    if (continuation && (!integer(lastAt) || typeof lastID !== 'string' || !lastID.length) || !continuation && lastID !== null)
        throw new ApiError(503, 'retention_cursor_invalid');
    const rows = await ctx.db.all<any>(`SELECT r.*,${order} retention_scan_at FROM ${fromWhere}
      ${continuation ? `AND (${order}>? OR (${order}=? AND r.id>?))` : ''}
      ORDER BY ${order},r.id LIMIT ?`, ...bindings, ...(continuation ? [lastAt, lastAt, lastID] : []), maximum);
    const last = rows.at(-1);
    await ctx.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES(?,'',?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id", scan, last?.retention_scan_at ?? null, last?.id ?? null);
    return rows;
}
async function pruneTerminalOperationCopies(ctx: AppContext, maximum: number): Promise<void> {
    const budget = { left: maximum };
    for (const support of await terminalScan(ctx, 'support', `support_requests r WHERE r.status IN('closed','resolved')
      AND r.category='general_support' AND r.updated_at<=?
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=r.account_id)`, 'r.updated_at', [ctx.now() - 90 * DAY], maximum)) {
        const complete = await retireLinkedOperations(ctx, {
            entity: support.id, subjects: [support.account_id],
            sql: "o.source='support' AND (json_extract(o.payload_json,'$.request_id')=? OR json_extract(o.response_json,'$.id')=? OR json_extract(CASE WHEN json_valid(json_extract(o.response_json,'$.support_request')) THEN json_extract(o.response_json,'$.support_request') ELSE '{}' END,'$.id')=?)",
            bindings: [support.id, support.id, support.id],
            valid: (row, input, result) => supportOperation(row, input, result, support),
        }, budget);
        if (complete) await ctx.db.run('DELETE FROM support_requests WHERE id=?', support.id);
    }
    for (const guardian of await terminalScan(ctx, 'guardian', `guardian_requests r
      WHERE r.state IN('rejected','withdrawn','expired') AND r.terminated_at IS NOT NULL AND r.terminated_at<=?
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.subject_id=r.child_account_id OR h.subject_id=r.guardian_account_id))`, 'r.terminated_at', [ctx.now() - 365 * DAY], maximum)) {
        const complete = await retireLinkedOperations(ctx, {
            entity: guardian.id, subjects: [guardian.child_account_id, guardian.guardian_account_id, guardian.reviewed_by].filter((id): id is string => typeof id === 'string'),
            sql: "o.source='guardian' AND (json_extract(o.payload_json,'$.target_id')=? OR json_extract(o.response_json,'$.request_id')=?)",
            bindings: [guardian.id, guardian.id],
            valid: (row, input, result) => guardianOperation(row, input, result, guardian),
        }, budget);
        if (complete) await ctx.db.run('DELETE FROM guardian_requests WHERE id=?', guardian.id);
    }
    for (const review of await terminalScan(ctx, 'adult', `audience_adult_reviews r WHERE r.created_at<=?
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=r.account_id)`, 'r.created_at', [ctx.now() - 365 * DAY], maximum)) {
        // Old receipts contain no review-row ID. Only an unambiguous exact tuple
        // is a positive binding; absence, reused evidence and orphans are not.
        const matches = await ctx.db.one<{ n: number }>('SELECT count(*) n FROM audience_adult_reviews WHERE account_id=? AND reviewed_by=? AND evidence_method=? AND evidence_reference=?', review.account_id, review.reviewed_by, review.evidence_method, review.evidence_reference);
        if (matches?.n !== 1) continue;
        const generation = await adultReceiptGeneration(ctx, review.id);
        if (!generation) continue;
        const complete = await retireLinkedOperations(ctx, {
            entity: review.id, subjects: [review.account_id, review.reviewed_by],
            sql: "o.source='audience' AND o.action='audience.adult-review' AND o.actor_id=? AND (json_extract(o.payload_json,'$.target_id')=? OR json_extract(o.response_json,'$.account_id')=?)",
            bindings: [review.reviewed_by, review.account_id, review.account_id],
            valid: (_row, input, result) => adultOperationLink(ctx, input, result, review),
            continuation: { generation, currentGeneration: () => adultReceiptGeneration(ctx, review.id) },
        }, budget);
        if (complete) {
            await ctx.db.run('DELETE FROM audience_adult_reviews WHERE id=?', review.id);
            await ctx.db.run('DELETE FROM retention_scan_cursors WHERE scan=? AND entity_id=?', 'adult', review.id);
        }
    }
    // Only operation copies are minimized here. Minimal privacy request/status
    // facts and their separate retention/restore-suppression lifecycle remain.
    for (const request of await terminalScan(ctx, 'privacy', `privacy_requests r WHERE r.status IN('completed','rejected','cancelled')
      AND coalesce(r.completed_at,r.reviewed_at) IS NOT NULL AND coalesce(r.completed_at,r.reviewed_at)<=?
      AND NOT EXISTS(SELECT 1 FROM privacy_exports e WHERE e.request_id=r.id AND e.status<>'retired')
      AND NOT EXISTS(SELECT 1 FROM privacy_export_grants g WHERE g.request_id=r.id AND g.consumed_at IS NULL AND g.expires_at>?)`, 'coalesce(r.completed_at,r.reviewed_at)', [ctx.now() - 365 * DAY, ctx.now()], maximum)) {
        await retireLinkedOperations(ctx, {
            entity: request.id, subjects: [request.subject_id],
            sql: "o.source='privacy' AND (json_extract(o.payload_json,'$.request_id')=? OR json_extract(CASE WHEN json_valid(json_extract(o.response_json,'$.privacy_request')) THEN json_extract(o.response_json,'$.privacy_request') ELSE '{}' END,'$.id')=?)",
            bindings: [request.id, request.id],
            valid: (row, input, result) => privacyOperation(row, input, result, request),
        }, budget);
    }
}

/** Bounded, class-specific metadata erasure. This never touches financial records,
 * unresolved cleanup/writer obligations, or a scoped/global hold. Provider logs
 * and backups are separately configured and cannot be qualified by this job. */
export async function pruneRetainedMetadata(ctx: AppContext, maximum = 100): Promise<void> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 200) throw new ApiError(400, 'retention_limit_invalid');
    await ctx.db.transaction(async () => {
    const p = await policy(ctx);
    if (p.legal_hold) return;
    await pruneTerminalOperationCopies(ctx, maximum);
    const events = await ctx.db.all<{id:string}>(`SELECT e.id FROM audit_events e
      WHERE e.created_at <= ? - CASE
        WHEN e.action LIKE 'privacy.%' OR e.action LIKE 'guardian.%' OR e.action LIKE 'audience.%' OR e.action LIKE 'consent.%'
          OR e.action LIKE 'face_profile.%' OR e.action LIKE 'admin.%' OR e.action LIKE 'support.%' OR e.action LIKE 'moderation.%'
          OR EXISTS(SELECT 1 FROM accounts admin_actor WHERE admin_actor.id=e.actor_id AND instr(admin_actor.roles_json,'"admin"')>0) THEN ?
        WHEN e.action LIKE 'face.%' OR e.action LIKE 'auth.%' OR e.action LIKE 'session.%' OR e.action LIKE 'device.%' OR e.action LIKE 'security.%' THEN ?
        ELSE ? END
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.subject_id=e.subject_id OR h.subject_id=e.actor_id))
      AND NOT EXISTS(SELECT 1 FROM cleanup_intents c WHERE c.subject_id=e.subject_id AND c.status<>'verified')
      ORDER BY e.created_at,e.id LIMIT ?`,ctx.now(),365*DAY,p.audit_days*DAY,7*DAY,maximum);
    for (const event of events) await ctx.db.run('DELETE FROM audit_events WHERE id=?',event.id);
    // These rows contain minimal consent facts already. References held by an
    // active or unresolved operation prevent premature deletion; no FK bypass.
    await ctx.db.run(`DELETE FROM consents WHERE id IN(SELECT c.id FROM consents c
      WHERE (c.revoked_at IS NOT NULL OR c.expires_at IS NOT NULL AND c.expires_at<=?)
      AND coalesce(c.revoked_at,c.expires_at,c.created_at)<=?
      AND NOT EXISTS(SELECT 1 FROM face_profiles f WHERE f.consent_id=c.id OR f.auth_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.face_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM auth_challenges a WHERE a.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_enrollment_intents i WHERE i.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_recovery_keys k WHERE k.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_profile_operations o WHERE o.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM match_origins o WHERE o.matching_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=c.account_id)
      ORDER BY c.created_at,c.id LIMIT ?)`,ctx.now(),ctx.now()-365*DAY,maximum);
    });
}
