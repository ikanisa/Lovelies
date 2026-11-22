import { pruneDownloadEvidence } from './download-v2-retention.ts';
import { retireDownloadEvidence } from './download-v2-persistence.ts';
import { asyncSome } from './async-collections.ts';
import { verifiedGrantReceipt } from './privacy-export-grant.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext, type Binding, type Database } from './types.ts';
import { assertOperationReceiptAvailable, executeOperation, prepareOperation, retiredOperationInput, retiredOperationResponse, type PreparedOperation } from './operations.ts';
import { restoreAllocationID, restoreOperationID, type RestoreTransactionScope } from './restore-transaction.ts';
import { hasConsent } from './gallery.ts';
import { mediaHeld, requireOperator } from './operators.ts';
import { AUDIENCE_POLICY, assertAudienceCapability } from './audience.ts';
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
    `CREATE TABLE IF NOT EXISTS retention_schedule_commands(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source='retention'),operation_key TEXT NOT NULL,payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),limit_count INTEGER NOT NULL CHECK(limit_count BETWEEN 1 AND 200),planned_count INTEGER NOT NULL CHECK(planned_count BETWEEN 0 AND limit_count),next_position INTEGER NOT NULL CHECK(next_position BETWEEN 0 AND planned_count),plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),created_at INTEGER NOT NULL,UNIQUE(actor_id,source,operation_key),FOREIGN KEY(actor_id,source,operation_key) REFERENCES operations(actor_id,source,operation_key) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS retention_schedule_items(command_id TEXT NOT NULL REFERENCES retention_schedule_commands(id) ON DELETE CASCADE,position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 199),asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,source_version TEXT NOT NULL,snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),outcome TEXT NOT NULL CHECK(outcome IN('pending','raw','preview','replaced','already_retired')),completion_id TEXT,superseding_id TEXT,CHECK((outcome='pending')=(completion_id IS NULL)),CHECK((outcome='already_retired')=(superseding_id IS NOT NULL)),PRIMARY KEY(command_id,position),UNIQUE(command_id,asset_id))`,
    `CREATE TABLE IF NOT EXISTS retention_schedule_commit_guards(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,auth_epoch INTEGER NOT NULL,deadline_db_ms INTEGER NOT NULL)`,
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
async function createJob(ctx: AppContext, p: Policy, subject: string, asset: string | null, kind: Job['kind'], version: string, binding: unknown, objects: PrivateObject[], allocatedJob?: string, conflict?: Error): Promise<void> {
    // Neither raw nor preview episode identity includes policy. Preserve every
    // existing obligation even if its prior policy or provider outcome is old.
    if (kind === 'raw' && asset && (await rawObligation(ctx, asset, version) || await unresolvedPreviewObligation(ctx, asset, version))) throw conflict ?? new ApiError(409, 'retention_job_conflict');
    if (kind === 'preview' && asset && await previewObligation(ctx, asset, version)) throw conflict ?? new ApiError(409, 'retention_job_conflict');
    const prior = (await ctx.db.one('SELECT id FROM retention_jobs WHERE subject_id=? AND kind=? AND object_version=? AND policy_version=? AND asset_id IS NOT DISTINCT FROM ?', subject, kind, version, p.version, asset));
    // A raw expiry plan allocates its job identity independently. An existing
    // job for a still-live source is ambiguous; never adopt it as this plan.
    if (prior) {
        if (allocatedJob) throw conflict ?? new ApiError(409, 'retention_job_conflict');
        return;
    }
    const id = allocatedJob ?? crypto.randomUUID();
    (await ctx.db.run("INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)", id, subject, asset, kind, stable(binding), p.version, version, ctx.now()));
    for (const item of objects)
        (await ctx.db.run("INSERT INTO retention_objects(id,job_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,'pending',?)", crypto.randomUUID(), id, item.bucket, item.object_key, ctx.now()));
}
/** A nonterminal deletion-request hold applies to the subject's retained evidence. */
async function subjectDeletionHold(ctx: AppContext, subject: string): Promise<boolean> {
    try {
        return !!(await ctx.db.one(`SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete'
          AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled') LIMIT 1`, subject));
    } catch {
        // Failure to read hold state is not permission to retry an uncertain DELETE.
        throw new ApiError(409, 'retention_request_hold_unavailable');
    }
}
async function hold(ctx: AppContext, job: Job, p: Policy): Promise<boolean> {
    if (p.legal_hold || await subjectDeletionHold(ctx, job.subject_id))
        return true;
    if (job.asset_id)
        return !!(await ctx.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=? AND legal_hold=1', job.asset_id)) || (await mediaHeld(ctx, job.subject_id, job.asset_id));
    return !!(await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=?', job.subject_id));
}
async function current(ctx: AppContext, id: string, lease?: string, conflict?: Error): Promise<{
    job: Job;
    binding: any;
}> {
    const job = (await ctx.db.one<Job>('SELECT * FROM retention_jobs WHERE id=?', id));
    if (!job || job.status !== 'processing' || lease && job.lease_token !== lease || job.lease_until === null || job.lease_until <= ctx.now())
        throw new ApiError(409, 'retention_job_changed');
    if (conflict && (await jobEpisodeConflict(ctx, job) || await jobObjectOverlap(ctx, job.id))) throw conflict;
    const p = (await policy(ctx));
    // A policy change after claiming a preview preserves the lease and evidence;
    // after any external dispatch the caller stops rather than downgrading it.
    if (conflict && job.kind === 'preview' && p.version !== job.policy_version) throw conflict;
    if (await subjectDeletionHold(ctx, job.subject_id))
        throw new ApiError(503, 'retention_request_hold');
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
/** A conflict is tied to the asset and source version, not the owner field,
 * current policy, job state or lease. Preserve even malformed/old obligations. */
async function rawObligation(ctx: AppContext, asset: string, version: string): Promise<boolean> {
    return !!await ctx.db.one(`SELECT id FROM retention_jobs WHERE asset_id=? AND object_version=? AND kind='raw' LIMIT 1`, asset, version);
}
/** Preview episode identity is asset/version, independent of policy. Do not
 * adopt, overwrite or duplicate an existing job, including an empty inventory. */
async function previewObligation(ctx: AppContext, asset: string, version: string): Promise<boolean> {
    return !!await ctx.db.one(`SELECT id FROM retention_jobs WHERE asset_id=? AND object_version=? AND kind='preview' LIMIT 1`, asset, version);
}
/** Static SQL shared by health, bounded scans and locked checks. Aliases
 * preview_asset and preview_job always refer to the same asset/version episode.
 * This covers known rows only; it cannot prove complete restored inventory. */
const previewInventoryMismatchSQL = `(EXISTS(SELECT 1 FROM renditions rd WHERE rd.asset_id=preview_asset.id AND (rd.status='ready' OR NOT EXISTS(
    SELECT 1 FROM retention_objects o WHERE o.job_id=preview_job.id AND o.bucket='PHOTOS' AND o.object_key=rd.object_key)))
  OR EXISTS(SELECT 1 FROM processing_attempts pa WHERE pa.asset_id=preview_asset.id AND pa.rendition_key IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM retention_objects o WHERE o.job_id=preview_job.id AND o.bucket='PHOTOS' AND o.object_key=pa.rendition_key)))`;
const previewRawBlockSQL = `(preview_job.status<>'verified'
  OR EXISTS(SELECT 1 FROM retention_objects pending WHERE pending.job_id=preview_job.id AND pending.status<>'verified')
  OR EXISTS(SELECT 1 FROM retention_jobs peer WHERE peer.asset_id=preview_job.asset_id AND peer.object_version=preview_job.object_version
    AND peer.kind='preview' AND peer.id<>preview_job.id)
  OR ${previewInventoryMismatchSQL})`;
/** A raw expiry cannot invalidate an unfinished, duplicated or inventory-
 * inconsistent preview episode, including one with no recorded object keys. */
async function unresolvedPreviewObligation(ctx: AppContext, asset: string, version: string): Promise<boolean> {
    return !!await ctx.db.one(`SELECT preview_job.id FROM retention_jobs preview_job LEFT JOIN assets preview_asset
      ON preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
      WHERE preview_job.asset_id=? AND preview_job.object_version=? AND preview_job.kind='preview' AND ${previewRawBlockSQL} LIMIT 1`, asset, version);
}
async function previewInventoryMismatch(ctx: AppContext, asset: string, version: string): Promise<boolean> {
    return !!await ctx.db.one(`SELECT preview_job.id FROM retention_jobs preview_job JOIN assets preview_asset
      ON preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
      WHERE preview_job.asset_id=? AND preview_job.object_version=? AND preview_job.kind='preview' AND ${previewInventoryMismatchSQL} LIMIT 1`, asset, version);
}
/** Quarantine a live source with a raw job, or duplicated raw/preview episodes
 * even after replacement or retirement; obligations may share private keys. */
async function jobEpisodeConflict(ctx: AppContext, job: Job): Promise<boolean> {
    if (!job.asset_id) return false;
    if (await ctx.db.one(`SELECT first_job.id FROM retention_jobs first_job
      WHERE first_job.asset_id=? AND first_job.object_version=? AND first_job.kind='raw'
      AND (EXISTS(SELECT 1 FROM assets a WHERE a.id=first_job.asset_id AND a.version=first_job.object_version AND a.deleted_at IS NULL)
        OR EXISTS(SELECT 1 FROM retention_jobs other_job WHERE other_job.asset_id=first_job.asset_id AND other_job.object_version=first_job.object_version
          AND other_job.kind='raw' AND other_job.id<>first_job.id)) LIMIT 1`, job.asset_id, job.object_version)) return true;
    if (await ctx.db.one(`SELECT first_job.id FROM retention_jobs first_job JOIN retention_jobs peer
      ON peer.asset_id=first_job.asset_id AND peer.object_version=first_job.object_version AND peer.kind='preview' AND peer.id<>first_job.id
      WHERE first_job.asset_id=? AND first_job.object_version=? AND first_job.kind='preview' LIMIT 1`, job.asset_id, job.object_version)) return true;
    if (job.kind === 'raw' && await unresolvedPreviewObligation(ctx, job.asset_id, job.object_version)) return true;
    return previewInventoryMismatch(ctx, job.asset_id, job.object_version);
}
async function anyRawConflict(ctx: AppContext): Promise<boolean> {
    return !!await ctx.db.one(`SELECT first_job.id FROM retention_jobs first_job WHERE first_job.kind='raw' AND first_job.asset_id IS NOT NULL
      AND (EXISTS(SELECT 1 FROM assets a WHERE a.id=first_job.asset_id AND a.version=first_job.object_version AND a.deleted_at IS NULL)
        OR EXISTS(SELECT 1 FROM retention_jobs other_job WHERE other_job.asset_id=first_job.asset_id AND other_job.object_version=first_job.object_version
          AND other_job.kind='raw' AND other_job.id<>first_job.id)) LIMIT 1`);
}
/** Unresolved obligations sharing an exact private key must not race. This
 * only covers keys present in the current database, not missing restore data. */
async function jobObjectOverlap(ctx: AppContext, jobID: string): Promise<boolean> {
    return !!await ctx.db.one(`SELECT mine.id FROM retention_objects mine JOIN retention_objects other ON other.bucket=mine.bucket
      AND other.object_key=mine.object_key AND other.job_id<>mine.job_id JOIN retention_jobs peer ON peer.id=other.job_id
      WHERE mine.job_id=? AND (peer.status<>'verified' OR other.status<>'verified') LIMIT 1`, jobID);
}
async function anyJobObjectOverlap(ctx: AppContext): Promise<boolean> {
    return !!await ctx.db.one(`SELECT mine.id FROM retention_objects mine JOIN retention_jobs current_job ON current_job.id=mine.job_id
      JOIN retention_objects other ON other.bucket=mine.bucket AND other.object_key=mine.object_key AND other.job_id<>mine.job_id
      JOIN retention_jobs peer ON peer.id=other.job_id WHERE (current_job.status<>'verified' OR mine.status<>'verified')
      AND (peer.status<>'verified' OR other.status<>'verified') LIMIT 1`);
}
async function anySourceObjectOverlap(ctx: AppContext, p: Policy): Promise<boolean> {
    return !!await ctx.db.one(`SELECT a.id FROM assets a LEFT JOIN asset_retention r ON r.asset_id=a.id
      JOIN retention_objects o ON ((o.bucket='QUARANTINE' AND coalesce(r.raw_expires_at,a.created_at+?)<=? AND o.object_key=a.object_key)
        OR (o.bucket='PHOTOS' AND (EXISTS(SELECT 1 FROM renditions rd WHERE rd.asset_id=a.id AND rd.object_key=o.object_key)
          OR EXISTS(SELECT 1 FROM processing_attempts pa WHERE pa.asset_id=a.id AND pa.rendition_key=o.object_key))))
      JOIN retention_jobs j ON j.id=o.job_id WHERE a.deleted_at IS NULL
      AND (coalesce(r.raw_expires_at,a.created_at+?)<=? OR coalesce(r.preview_expires_at,a.created_at+?)<=?)
      AND (j.status<>'verified' OR o.status<>'verified') LIMIT 1`, p.raw_days*DAY,ctx.now(),p.raw_days*DAY,ctx.now(),p.preview_days*DAY,ctx.now());
}
async function sourceObjectOverlap(ctx: AppContext, objects: PrivateObject[]): Promise<boolean> {
    return asyncSome(objects, async item => !!await ctx.db.one(`SELECT o.id FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id
      WHERE o.bucket=? AND o.object_key=? AND (j.status<>'verified' OR o.status<>'verified') LIMIT 1`, item.bucket, item.object_key));
}
/** Keep local inventory mismatches visible even after a raw job has already
 * retired the source; a conflict must not disappear with deleted_at. */
async function anyPreviewConflict(ctx: AppContext, p: Policy): Promise<boolean> {
    return !!await ctx.db.one(`SELECT preview_job.id FROM retention_jobs preview_job WHERE preview_job.kind='preview' AND preview_job.asset_id IS NOT NULL AND (
      (preview_job.policy_version<>? AND (preview_job.status<>'verified' OR EXISTS(SELECT 1 FROM retention_objects o WHERE o.job_id=preview_job.id AND o.status<>'verified')))
      OR (preview_job.status='verified' AND EXISTS(SELECT 1 FROM retention_objects o WHERE o.job_id=preview_job.id AND o.status<>'verified'))
      OR EXISTS(SELECT 1 FROM retention_jobs peer WHERE peer.asset_id=preview_job.asset_id AND peer.object_version=preview_job.object_version AND peer.kind='preview' AND peer.id<>preview_job.id)
      OR EXISTS(SELECT 1 FROM assets preview_asset WHERE preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
        AND ${previewInventoryMismatchSQL})
      OR EXISTS(SELECT 1 FROM assets preview_asset LEFT JOIN asset_retention r ON r.asset_id=preview_asset.id
        WHERE preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version AND preview_asset.deleted_at IS NULL
          AND coalesce(r.raw_expires_at,preview_asset.created_at+?)<=? AND ${previewRawBlockSQL})) LIMIT 1`,
      p.version, p.raw_days * DAY, ctx.now());
}
type ScannedAssets = { policy: Policy; assets: any[]; conflict: boolean };
type ScheduledAsset = { policy: Policy; asset: any; rule: any; objects: PrivateObject[]; raw: boolean };
/** Apply the same exact-key hold/writer rules before LIMIT as well as inside
 * each transaction. Existing preview jobs cannot occupy the bounded page;
 * raw expiry waits for verified, consistent and nonduplicated preview evidence. */
async function scanExpiredAssets(ctx: AppContext, maximum: number): Promise<ScannedAssets> {
    const p = await policy(ctx), conflict = await anyRawConflict(ctx) || await anyPreviewConflict(ctx, p) ||
      await anyJobObjectOverlap(ctx) || await anySourceObjectOverlap(ctx, p);
    if (p.legal_hold) return { policy: p, assets: [], conflict };
    const assets = (await ctx.db.all<any>(`SELECT a.* FROM assets a LEFT JOIN asset_retention r ON r.asset_id=a.id
    WHERE a.deleted_at IS NULL AND (coalesce(r.raw_expires_at,a.created_at+?)<=? OR coalesce(r.preview_expires_at,a.created_at+?)<=?)
    AND coalesce(r.legal_hold,0)=0
    AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.asset_id=a.id OR h.subject_id=a.owner_id))
    AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.subject_id=a.owner_id AND h.request_type='delete'
      AND h.legal_hold=1 AND h.status NOT IN('completed','rejected','cancelled'))
    AND NOT EXISTS(SELECT 1 FROM retention_jobs conflict WHERE conflict.asset_id=a.id AND conflict.object_version=a.version AND conflict.kind='raw')
    AND NOT EXISTS(SELECT 1 FROM media_write_intents w WHERE w.status='pending' AND
      ((w.bucket='QUARANTINE' AND coalesce(r.raw_expires_at,a.created_at+?)<=? AND w.object_key=a.object_key)
       OR (w.bucket='PHOTOS' AND (EXISTS(SELECT 1 FROM renditions rd WHERE rd.asset_id=a.id AND rd.object_key=w.object_key)
         OR EXISTS(SELECT 1 FROM processing_attempts pa WHERE pa.asset_id=a.id AND pa.rendition_key=w.object_key)))))
    AND (coalesce(r.raw_expires_at,a.created_at+?)<=? OR NOT EXISTS(SELECT 1 FROM retention_jobs prior
      WHERE prior.asset_id=a.id AND prior.object_version=a.version AND prior.kind='preview'))
    AND (coalesce(r.raw_expires_at,a.created_at+?)>? OR NOT EXISTS(SELECT 1 FROM retention_jobs preview_job
      LEFT JOIN assets preview_asset ON preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
      WHERE preview_job.asset_id=a.id AND preview_job.object_version=a.version AND preview_job.kind='preview' AND ${previewRawBlockSQL}))
    AND NOT EXISTS(SELECT 1 FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id
      WHERE (j.status<>'verified' OR o.status<>'verified') AND
      ((o.bucket='QUARANTINE' AND coalesce(r.raw_expires_at,a.created_at+?)<=? AND o.object_key=a.object_key)
        OR (o.bucket='PHOTOS' AND (EXISTS(SELECT 1 FROM renditions rd WHERE rd.asset_id=a.id AND rd.object_key=o.object_key)
          OR EXISTS(SELECT 1 FROM processing_attempts pa WHERE pa.asset_id=a.id AND pa.rendition_key=o.object_key)))))
    ORDER BY a.created_at,a.id LIMIT ?`, p.raw_days * DAY, ctx.now(), p.preview_days * DAY, ctx.now(),
      p.raw_days * DAY, ctx.now(), p.raw_days * DAY, ctx.now(), p.raw_days * DAY, ctx.now(), p.raw_days * DAY, ctx.now(), maximum));
    return { policy: p, assets, conflict };
}
/** Re-select the exact scanned asset under the transaction lock and check all
 * existing policy, hold and unresolved-writer conditions before any transition. */
type AssetDeferred = 'deferred_policy' | 'deferred_hold' | 'deferred_writer' | 'deferred_deadline' | 'deferred_source';
type AssetSelection = {kind: 'ready'; value: ScheduledAsset} | {kind: AssetDeferred};
async function selectedAsset(ctx: AppContext, scannedPolicy: Policy, selected: any): Promise<AssetSelection> {
    const p = await policy(ctx);
    if (stable(p) !== stable(scannedPolicy)) return {kind: 'deferred_policy'};
    if (p.legal_hold) return {kind: 'deferred_hold'};
    const asset = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', selected.id);
    if (!asset || stable(asset) !== stable(selected) || asset.deleted_at !== null) return {kind: 'deferred_source'};
    if (await subjectDeletionHold(ctx, asset.owner_id)) return {kind: 'deferred_hold'};
    const rule = await assetPolicy(ctx, asset, p);
    if (rule.legal_hold || await mediaHeld(ctx, asset.owner_id, asset.id)) return {kind: 'deferred_hold'};
    const raw = rule.raw_expires_at <= ctx.now();
    if (!raw && rule.preview_expires_at > ctx.now()) return {kind: 'deferred_deadline'};
    const objects = await keys(ctx, asset, raw ? 'raw' : 'preview');
    if (await asyncSome(objects, async item => !!await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket=? AND object_key=? AND status='pending' LIMIT 1", item.bucket, item.object_key))) return {kind: 'deferred_writer'};
    if (await subjectDeletionHold(ctx, asset.owner_id)) return {kind: 'deferred_hold'};
    return {kind: 'ready', value: { policy: p, asset, rule, raw, objects: [...objects].sort((a, b) => { const x = a.bucket + ':' + a.object_key, y = b.bucket + ':' + b.object_key; return x < y ? -1 : x > y ? 1 : 0; }) }};
}
/** One raw asset/version is one independently recorded expiry episode. The
 * fact records the version for a future qualified replay; replay is not yet
 * implemented and this does not establish object inventory, remote deletion,
 * or recovery clearance. */
type ScheduleHooks = {
    begin: () => Promise<'ready' | 'replaced' | 'already_retired' | 'deferred_source' | 'deferred_policy' | 'deferred_hold' | 'deferred_writer' | 'stale'>;
    preview: (restore: RestoreTransactionScope) => Promise<{operationID: string; jobID: string}>;
    finish: (restore: RestoreTransactionScope, outcome: 'raw' | 'preview' | 'replaced' | 'already_retired', operationID?: string) => Promise<void>;
};
export async function scheduleExpiredAsset(ctx: AppContext, scannedPolicy: Policy, scanned: any, hooks?: ScheduleHooks): Promise<'scheduled' | 'replaced' | 'already_retired' | 'conflict' | 'stale' | AssetDeferred> {
    ctx.db.requireTransactionBoundary();
    return ctx.db.invocation(async () => {
      // Only this private, identity-compared sentinel denotes a conflict found
      // before prepare. The transaction adapter must return the original callback
      // error only after confirmed rollback; a lost rollback reply must escape.
      const conflict = new Error('retention_preprepare_conflict'), deferred = new Error('retention_preprepare_deferred');
      let deferredKind: AssetDeferred = 'deferred_source';
      try {
        return await ctx.db.transaction(async restore => {
        if (hooks) {
            const selection = await hooks.begin();
            if (selection === 'stale') return 'stale' as const;
            if (selection === 'deferred_source' || selection === 'deferred_policy' || selection === 'deferred_hold' || selection === 'deferred_writer') { deferredKind = selection; throw deferred; }
            if (selection === 'replaced' || selection === 'already_retired') { await hooks.finish(restore, selection); return selection; }
        }
        const selection = await selectedAsset(ctx, scannedPolicy, scanned);
        if (selection.kind !== 'ready') { deferredKind = selection.kind; throw deferred; }
        const selected = selection.value;
        const { policy: p, asset, rule, raw, objects } = selected;
        let jobID: string | undefined, itemOperationID: string | undefined;
        // A preview can overlap an unresolved raw job as well.
        if (await rawObligation(ctx, asset.id, asset.version) || await sourceObjectOverlap(ctx, objects) ||
            (raw ? await unresolvedPreviewObligation(ctx, asset.id, asset.version) : await previewObligation(ctx, asset.id, asset.version))) throw conflict;
        if (raw) {
            const episode = await digest(stable({ asset_id: asset.id, asset_version: asset.version }));
            const operationID = await restoreOperationID(asset.owner_id, 'retention.raw-expiry-v1', 'retention.raw:' + episode);
            jobID = await restoreAllocationID(operationID, 'id_0');
            itemOperationID = operationID;
            restore.operation({ operation_id: operationID, input_hash: await digest(stable({ protocol: 'lovelies-raw-retention-expiry-v1',
                owner_id: asset.owner_id, asset_id: asset.id, asset_version: asset.version, object_key: asset.object_key,
                source_checksum: asset.checksum_sha256, retention_version: rule.version, retention_policy: p.version,
                raw_expires_at: rule.raw_expires_at, objects })), allocations: { id_0: jobID } });
            await restore.restrict('asset-retired', { owner_id: asset.owner_id, asset_id: asset.id, asset_version: asset.version });
        } else if (hooks) {
            const preview = await hooks.preview(restore);
            itemOperationID = preview.operationID; jobID = preview.jobID;
        }
        // Recheck every selected input after the await and before changing SQL.
        const current = await selectedAsset(ctx, scannedPolicy, scanned);
        if (current.kind !== 'ready') { deferredKind = current.kind; throw deferred; }
        if (stable(current.value) !== stable(selected)) { deferredKind = 'deferred_source'; throw deferred; }
        // Still inside the callback, before independent prepare or SQL effects.
        if (await rawObligation(ctx, asset.id, asset.version) || await sourceObjectOverlap(ctx, objects) ||
            (raw ? await unresolvedPreviewObligation(ctx, asset.id, asset.version) : await previewObligation(ctx, asset.id, asset.version))) throw conflict;
        const deleted = raw ? ctx.now() : null;
        if (raw) {
            await ctx.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=? AND version=? AND deleted_at IS NULL", deleted, asset.id, asset.version);
            const after = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', asset.id);
            if (!after || stable(after) !== stable({ ...asset, status: 'expired', deleted_at: deleted })) throw new ApiError(409, 'retention_source_changed');
            await ctx.db.run("UPDATE processing_attempts SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE asset_id=? AND status<>'completed'", asset.id);
            await ctx.db.run("UPDATE photo_job_outbox SET status='cancelled' WHERE asset_id=?", asset.id);
            await ctx.db.run("UPDATE candidates SET status='expired',version=? WHERE asset_id=?", crypto.randomUUID(), asset.id);
        }
        await ctx.db.run("UPDATE renditions SET status='retired' WHERE asset_id=?", asset.id);
        await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE asset_id=?', ctx.now(), asset.id);
        await ctx.db.run('DELETE FROM media_tickets WHERE asset_id=?', asset.id);
        await retireDownloadEvidence(ctx,asset.id,true);
        await ctx.db.run('DELETE FROM download_tickets WHERE asset_id=?', asset.id);
        if (await sourceObjectOverlap(ctx, objects)) throw conflict;
        await createJob(ctx, p, asset.owner_id, asset.id, raw ? 'raw' : 'preview', asset.version,
            { object_key: asset.object_key, checksum: asset.checksum_sha256, retention_version: rule.version, deleted_at: deleted }, objects, jobID, conflict);
        if (hooks) await hooks.finish(restore, raw ? 'raw' : 'preview', itemOperationID);
        return 'scheduled' as const;
        });
      } catch (error) {
        if (error === conflict) return 'conflict' as const;
        if (error === deferred) return deferredKind;
        throw error; // Never downgrade admission, prepare, commit or ack uncertainty.
      }
    });
}
/** Profile scanning still uses its prior batch and requires a separate
 * exact-profile/session journal protocol before restore recovery is complete. */
async function snapshotExpiredProfiles(ctx: AppContext, maximum: number, scannedPolicy: Policy): Promise<void> {
    const p = await policy(ctx);
    if (p.legal_hold || stable(p) !== stable(scannedPolicy)) return;
    for (const profile of (await ctx.db.all<any>(`SELECT f.* FROM face_profiles f WHERE f.status='active'
    AND NOT EXISTS(SELECT 1 FROM consents c WHERE c.account_id=f.account_id AND c.purpose IN('face_authentication','photo_matching') AND c.status='granted' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?))
    AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.subject_id=f.account_id AND h.request_type='delete'
      AND h.legal_hold=1 AND h.status NOT IN('completed','rejected','cancelled'))
    ORDER BY f.account_id LIMIT ?`, ctx.now(), maximum))) {
        if (!profile.template_key || (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=?', profile.account_id)) || (await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket='PHOTOS' AND object_key=? AND status='pending'", profile.template_key)))
            continue;
        if (await subjectDeletionHold(ctx, profile.account_id)) continue;
        (await ctx.db.run("UPDATE face_profiles SET status='revoked',auth_enabled=0,auth_epoch=auth_epoch+1 WHERE account_id=?", profile.account_id));
        (await ctx.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', profile.account_id));
        (await ctx.db.run('UPDATE sessions SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?', ctx.now(), profile.account_id));
        (await ctx.db.run("UPDATE auth_challenges SET status='cancelled' WHERE account_id=?", profile.account_id));
        (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE recipient_id=?', ctx.now(), profile.account_id));
        (await ctx.db.run("UPDATE candidates SET status='expired',version=? WHERE recipient_id=?", crypto.randomUUID(), profile.account_id));
        (await createJob(ctx, p, profile.account_id, null, 'profile', profile.revision, { template_key: profile.template_key, template_digest: profile.template_digest }, [{ bucket: 'PHOTOS', object_key: profile.template_key }]));
    }
}
/** Post-prepare authority check and a DB-clock deadline enforced by a deferred
 * trigger during COMMIT. This assumes cooperative writers retain the advisory
 * lock, a monotonic/correct DB clock and the installed trigger definition. */
async function scheduleGuardAvailable(ctx: AppContext): Promise<void> {
    const row = await ctx.db.one<{tgdeferrable: boolean; tginitdeferred: boolean; tgenabled: string; tgtype: number; relrowsecurity: boolean; relforcerowsecurity: boolean; proname: string; replication_role: string}>(
      `SELECT t.tgdeferrable,t.tginitdeferred,t.tgenabled,t.tgtype,c.relrowsecurity,c.relforcerowsecurity,p.proname,current_setting('session_replication_role') AS replication_role
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
       WHERE n.nspname='lovelies_private' AND c.relname='retention_schedule_commit_guards' AND t.tgname='retention_schedule_commit_guard'
         AND pn.nspname='lovelies_private' AND NOT t.tgisinternal`);
    if (!row || row.tgdeferrable !== true || row.tginitdeferred !== true || row.tgenabled !== 'O' || Number(row.tgtype) !== 5 ||
        !row.relrowsecurity || !row.relforcerowsecurity || row.replication_role !== 'origin' || row.proname !== 'retention_schedule_check_commit_guard')
        throw new ApiError(503, 'retention_schedule_guard_unavailable');
}
async function registerScheduleGuard(ctx: AppContext, actor: Actor, expectedPolicy?: () => Policy | undefined): Promise<void> {
    await scheduleGuardAvailable(ctx);
    ctx.db.beforeCommit(async () => {
        await scheduleGuardAvailable(ctx);
        await requireOperator(ctx, actor, true);
        const expected = expectedPolicy?.();
        if (expected) {
            const current = await ctx.db.one<Policy>("SELECT * FROM retention_settings WHERE id='default'");
            if (!current || stable(current) !== stable(expected) || current.legal_hold) throw new ApiError(503, 'retention_schedule_policy_changed');
        }
        // Capture the actual selected audience episode, not every potential
        // guardian approval. Ordinary operator authorization still runs above.
        const audience = JSON.parse(await assertAudienceCapability(ctx, actor.accountId, 'face_authentication')) as {approval?: string};
        const audienceRow = await ctx.db.one<{next_review_at: number | null}>('SELECT next_review_at FROM account_audience WHERE account_id=?', actor.accountId);
        const now = ctx.now();
        const own = await ctx.db.one<{session_exp: number; refresh_exp: number; consent_exp: number | null; used_at: number}>(`
          SELECT s.expires_at AS session_exp,s.refresh_expires_at AS refresh_exp,own_consent.expires_at AS consent_exp,c.used_at
          FROM sessions s JOIN consents own_consent ON own_consent.id=s.face_consent_id JOIN auth_challenges c
            ON c.account_id=s.account_id AND c.device_id=s.device_id AND c.device_revision=s.device_revision
           AND c.profile_revision=s.face_profile_revision AND c.profile_auth_epoch=s.face_profile_epoch
           AND c.auth_epoch=s.auth_epoch AND c.consent_id=s.face_consent_id
          WHERE s.id=? AND s.account_id=? AND c.purpose='login' AND c.status='used' AND c.used_at>=? AND c.used_at<=?
            AND c.created_at<=s.created_at AND c.used_at>=s.created_at ORDER BY c.used_at DESC LIMIT 1`,
          actor.sessionId, actor.accountId, now - 300000, now);
        if (!own || !audienceRow) throw new ApiError(503, 'retention_schedule_guard_unavailable');
        const deadlines: Array<number | null> = [actor.expiresAt, own.session_exp, own.refresh_exp, own.consent_exp, own.used_at + 300000, audienceRow.next_review_at];
        if (audience.approval !== undefined) {
            const guardian = await ctx.db.one<{approval_exp: number; request_exp: number; guardian_review: number | null; guardian_consent_exp: number | null}>(`
              SELECT p.expires_at AS approval_exp,r.expires_at AS request_exp,g.next_review_at AS guardian_review,c.expires_at AS guardian_consent_exp
              FROM guardian_purpose_approvals p JOIN guardian_requests r ON r.id=p.request_id
              JOIN account_audience g ON g.account_id=p.guardian_account_id JOIN face_profiles fp ON fp.account_id=g.account_id
              JOIN consents c ON c.id=fp.auth_consent_id WHERE p.id=? AND p.child_account_id=?`, audience.approval, actor.accountId);
            if (!guardian) throw new ApiError(503, 'retention_schedule_guard_unavailable');
            deadlines.push(guardian.approval_exp, guardian.request_exp, guardian.guardian_review, guardian.guardian_consent_exp);
        }
        if (deadlines.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new ApiError(503, 'retention_schedule_guard_unavailable');
        const until = Math.min(...deadlines.filter((value): value is number => value !== null));
        // Calibrate remaining app-authority lifetime into the server-clock
        // domain. The DB time is sampled before the later app time, making the
        // derived deadline conservative absent clock jumps or abnormal skew.
        const dbClock = await ctx.db.one<{ms: number}>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms");
        const remaining = until - ctx.now();
        if (!dbClock || !Number.isSafeInteger(dbClock.ms) || !Number.isSafeInteger(remaining) || remaining <= 0 || !Number.isSafeInteger(dbClock.ms + remaining))
            throw new ApiError(503, 'retention_schedule_authority_expired');
        await ctx.db.run('INSERT INTO retention_schedule_commit_guards(id,actor_id,session_id,auth_epoch,deadline_db_ms) VALUES(?,?,?,?,?)',
            crypto.randomUUID(), actor.accountId, actor.sessionId, actor.authEpoch, dbClock.ms + remaining);
    });
}

// A reserved receipt owns one bounded manual scheduling plan. It is not a
// successful receipt until the complete plan and profile scan have committed.
const SCHEDULE_PENDING = 'lovelies-retention-schedule-pending-v1';
type ScheduleItem = { position: number; asset_id: string; owner_id: string; source_version: string; snapshot_hash: string;
    outcome: 'pending' | 'raw' | 'preview' | 'replaced' | 'already_retired'; completion_id: string | null; superseding_id: string | null };
type ScheduleCommand = { id: string; actor_id: string; source: string; operation_key: string; payload_hash: string;
    policy_json: string; limit_count: number; planned_count: number; next_position: number; plan_hash: string };
type ScheduleReceipt = { action: string; payload_hash: string; payload_json: string; response_json: string };
type ScheduleState = { kind: 'complete'; response: Record<string, unknown> } |
    { kind: 'pending'; command: ScheduleCommand; policy: Policy; items: ScheduleItem[] };
const scheduleUnavailable = (): never => { throw new ApiError(503, 'retention_schedule_state_unavailable'); };
const hash64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const schedulePlanHash = (intent: PreparedOperation, limit: number, p: Policy, items: ScheduleItem[]) =>
    digest(stable({ protocol: 'lovelies-retention-schedule-plan-v1', input_hash: intent.hash, limit, policy: p,
        items: items.map(({position, asset_id, owner_id, source_version, snapshot_hash}) => ({position, asset_id, owner_id, source_version, snapshot_hash})) }));
/** A later raw retirement is terminal only with both the exact independently
 * committed restriction/allocation and its matching local source/job binding. */
async function verifiedRawRetirement(ctx: AppContext, item: ScheduleItem, asset: any): Promise<string | null> {
    if (!asset || asset.id !== item.asset_id || asset.owner_id !== item.owner_id || asset.version !== item.source_version ||
        asset.status !== 'expired' || asset.deleted_at === null) return null;
    const operationID = await restoreOperationID(item.owner_id, 'retention.raw-expiry-v1',
        'retention.raw:' + await digest(stable({ asset_id: item.asset_id, asset_version: item.source_version })));
    const prior = await ctx.db.verifiedRestoreOperation(operationID);
    const jobID = await restoreAllocationID(operationID, 'id_0');
    const event = {owner_id: item.owner_id, asset_id: item.asset_id, asset_version: item.source_version};
    if (!prior || prior.status !== 'committed' || stable(prior.plan.allocations) !== stable({id_0: jobID}) || prior.plan.events.length !== 1 ||
        prior.plan.events[0].kind !== 'asset-retired' || stable(prior.plan.events[0].scope) !== stable(event)) return null;
    const job = await ctx.db.one<{subject_id:string; asset_id:string; object_version:string; kind:string; binding_json:string}>(
        'SELECT subject_id,asset_id,object_version,kind,binding_json FROM retention_jobs WHERE id=?', jobID);
    if (!job || job.subject_id !== item.owner_id || job.asset_id !== item.asset_id || job.object_version !== item.source_version || job.kind !== 'raw') return null;
    let binding: any; try { binding = JSON.parse(job.binding_json); } catch { return null; }
    if (!binding || binding.object_key !== asset.object_key || binding.checksum !== asset.checksum_sha256 || binding.deleted_at !== asset.deleted_at) return null;
    return operationID;
}
async function scheduleState(ctx: AppContext, actor: Actor, intent: PreparedOperation, expectedCommand: string): Promise<ScheduleState | null> {
    const row = await ctx.db.one<ScheduleReceipt>('SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, intent.source, intent.key);
    if (!row) return null;
    if (row.action !== intent.action || row.payload_hash !== intent.hash) throw new ApiError(409, 'operation_key_conflict');
    assertOperationReceiptAvailable(row);
    if (row.payload_json !== intent.payloadJson) throw new ApiError(409, 'operation_key_conflict');
    let response: any;
    try { response = JSON.parse(row.response_json); } catch { return scheduleUnavailable(); }
    if (!response || typeof response !== 'object' || Array.isArray(response)) return scheduleUnavailable();
    const command = await ctx.db.one<ScheduleCommand>('SELECT * FROM retention_schedule_commands WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, intent.source, intent.key);
    if (response.protocol !== SCHEDULE_PENDING) {
        if (command || Object.keys(response).sort().join(',') !== 'operation_key,scheduled' || response.scheduled !== true || response.operation_key !== intent.key) return scheduleUnavailable();
        return { kind: 'complete', response };
    }
    if (Object.keys(response).sort().join(',') !== 'command_id,protocol' || response.command_id !== expectedCommand || !command || command.id !== expectedCommand ||
        command.actor_id !== actor.accountId || command.source !== intent.source || command.operation_key !== intent.key || command.payload_hash !== intent.hash ||
        !Number.isSafeInteger(command.limit_count) || command.limit_count < 1 || command.limit_count > 200 ||
        !Number.isSafeInteger(command.planned_count) || command.planned_count < 0 || command.planned_count > command.limit_count ||
        !Number.isSafeInteger(command.next_position) || command.next_position < 0 || command.next_position > command.planned_count || !hash64(command.plan_hash)) return scheduleUnavailable();
    let p: Policy;
    try { p = JSON.parse(command.policy_json); } catch { return scheduleUnavailable(); }
    if (!p || p.id !== 'default' || stable(p) !== command.policy_json || !Number.isSafeInteger(p.version) || p.version < 1) return scheduleUnavailable();
    const items = await ctx.db.all<ScheduleItem>('SELECT position,asset_id,owner_id,source_version,snapshot_hash,outcome,completion_id,superseding_id FROM retention_schedule_items WHERE command_id=? ORDER BY position LIMIT 201', command.id);
    if (items.length !== command.planned_count || items.some((item, index) => item.position !== index ||
        typeof item.asset_id !== 'string' || typeof item.owner_id !== 'string' || typeof item.source_version !== 'string' || !hash64(item.snapshot_hash) ||
        (index < command.next_position ? !['raw','preview','replaced','already_retired'].includes(item.outcome) || typeof item.completion_id !== 'string' : item.outcome !== 'pending' || item.completion_id !== null || item.superseding_id !== null)) ||
        await schedulePlanHash(intent, command.limit_count, p, items) !== command.plan_hash) return scheduleUnavailable();
    const expectedJobs: Array<{id: string; asset_id: string; owner_id: string; version: string; kind: string}> = [];
    for (const item of items.slice(0, command.next_position)) {
        const id = item.outcome === 'raw' ? await restoreOperationID(item.owner_id, 'retention.raw-expiry-v1',
            'retention.raw:' + await digest(stable({ asset_id: item.asset_id, asset_version: item.source_version }))) : (await scheduleStepIdentity(actor, command, item)).operation_id;
        if (item.completion_id !== id) return scheduleUnavailable();
        if (item.outcome === 'replaced') {
            const current = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', item.asset_id);
            if (!current || current.owner_id !== item.owner_id || current.version === item.source_version || item.superseding_id !== null) return scheduleUnavailable();
        } else if (item.outcome === 'already_retired') {
            const current = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', item.asset_id);
            const retired = await verifiedRawRetirement(ctx, item, current);
            if (!retired || item.superseding_id !== retired) return scheduleUnavailable();
        } else if (item.superseding_id !== null) return scheduleUnavailable();
        if (item.outcome === 'raw' || item.outcome === 'preview') expectedJobs.push({id: await restoreAllocationID(id, 'id_0'), asset_id: item.asset_id, owner_id: item.owner_id, version: item.source_version, kind: item.outcome});
    }
    for (let start = 0; start < expectedJobs.length; start += 100) {
        const expected = expectedJobs.slice(start, start + 100), placeholders = expected.map(() => '?').join(',');
        const actual = await ctx.db.all<{id: string; asset_id: string; subject_id: string; object_version: string; kind: string; job_status:string; owner_id: string; asset_version: string; status: string; deleted_at: number | null}>(
            `SELECT j.id,j.asset_id,j.subject_id,j.object_version,j.kind,j.status AS job_status,a.owner_id,a.version AS asset_version,a.status,a.deleted_at
              FROM retention_jobs j JOIN assets a ON a.id=j.asset_id WHERE j.id IN (${placeholders})`, ...expected.map(item => item.id));
        if (actual.length !== expected.length) return scheduleUnavailable();
        for (const item of expected) {
            const row = actual.find(value => value.id === item.id);
            if (!row || row.asset_id !== item.asset_id || row.subject_id !== item.owner_id || row.owner_id !== item.owner_id || row.object_version !== item.version ||
                row.asset_version !== item.version || row.kind !== item.kind) return scheduleUnavailable();
            if (item.kind === 'raw' && (row.status !== 'expired' || row.deleted_at === null)) return scheduleUnavailable();
            if (item.kind === 'preview' && row.deleted_at !== null) {
                const original = items.find(value => value.asset_id === item.asset_id)!;
                if (row.job_status !== 'verified' || await ctx.db.one("SELECT id FROM retention_objects WHERE job_id=? AND status<>'verified' LIMIT 1", item.id) ||
                    !await verifiedRawRetirement(ctx, original, await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', item.asset_id))) return scheduleUnavailable();
            }
        }
    }
    return { kind: 'pending', command, policy: p, items };
}
/** Reserve the ordinary operation key and selected source hashes atomically.
 * A subject's erased asset cascades its item; plan-hash/count verification then
 * fails closed rather than inventing successful completion or retaining its ID. */
async function reserveSchedule(ctx: AppContext, actor: Actor, intent: PreparedOperation, limit: number, operationID: string, commandID: string): Promise<ScheduleState> {
    return ctx.db.transaction(async restore => {
        await requireOperator(ctx, actor, true);
        await registerScheduleGuard(ctx, actor);
        const existing = await scheduleState(ctx, actor, intent, commandID);
        if (existing) { await requireOperator(ctx, actor, true); return existing; }
        const scan = await scanExpiredAssets(ctx, limit);
        const items: ScheduleItem[] = [];
        for (const [position, asset] of scan.assets.entries())
            items.push({ position, asset_id: asset.id, owner_id: asset.owner_id, source_version: asset.version, snapshot_hash: await digest(stable(asset)), outcome: 'pending', completion_id: null, superseding_id: null });
        const planHash = await schedulePlanHash(intent, limit, scan.policy, items);
        restore.operation({ operation_id: operationID, input_hash: await digest(stable({ protocol: 'lovelies-retention-schedule-reserve-v1', input_hash: intent.hash, plan_hash: planHash })),
            allocations: { id_0: commandID } });
        await requireOperator(ctx, actor, true);
        await ctx.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
            actor.accountId, intent.source, intent.key, intent.action, intent.hash, intent.payloadJson, stable({ protocol: SCHEDULE_PENDING, command_id: commandID }), ctx.now());
        await ctx.db.run('INSERT INTO operation_subjects(actor_id,source,operation_key,subject_id) VALUES(?,?,?,?)', actor.accountId, intent.source, intent.key, actor.accountId);
        await ctx.db.run(`INSERT INTO retention_schedule_commands(id,actor_id,source,operation_key,payload_hash,policy_json,limit_count,planned_count,next_position,plan_hash,created_at)
            VALUES(?,?,?,?,?,?,?,?,0,?,?)`, commandID, actor.accountId, intent.source, intent.key, intent.hash, stable(scan.policy), limit, items.length, planHash, ctx.now());
        for (const item of items) await ctx.db.run('INSERT INTO retention_schedule_items(command_id,position,asset_id,owner_id,source_version,snapshot_hash,outcome,completion_id,superseding_id) VALUES(?,?,?,?,?,?,?,?,?)',
            commandID, item.position, item.asset_id, item.owner_id, item.source_version, item.snapshot_hash, item.outcome, item.completion_id, item.superseding_id);
        await requireOperator(ctx, actor, true);
        const state = await scheduleState(ctx, actor, intent, commandID);
        if (!state || state.kind !== 'pending' || state.command.plan_hash !== planHash || state.command.next_position !== 0 || state.command.planned_count !== items.length) return scheduleUnavailable();
        return state;
    });
}
async function scheduleStepIdentity(actor: Actor, command: ScheduleCommand, item: ScheduleItem) {
    const key = 'retention.step:' + await digest(stable({ command_id: command.id, position: item.position }));
    return { operation_id: await restoreOperationID(actor.accountId, 'retention.schedule.step-v1', key),
        input_hash: await digest(stable({ protocol: 'lovelies-retention-schedule-step-v1', command_id: command.id,
            plan_hash: command.plan_hash, position: item.position, snapshot_hash: item.snapshot_hash })), allocations: {} };
}
/** Progress and the exact raw retirement live in the same SQL transaction and
 * independent plan. Only proven replacement or retirement is terminal; other changes defer. */
async function advanceScheduleAsset(ctx: AppContext, actor: Actor, intent: PreparedOperation, state: Extract<ScheduleState, {kind: 'pending'}>): Promise<void> {
    const item = state.items[state.command.next_position];
    if (!item) return scheduleUnavailable();
    const scanned = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', item.asset_id) ?? { id: item.asset_id };
    let supersedingID: string | null = null;
    const result = await scheduleExpiredAsset(ctx, state.policy, scanned, {
        begin: async () => {
            await requireOperator(ctx, actor, true);
            const current = await scheduleState(ctx, actor, intent, state.command.id);
            if (!current || current.kind === 'complete' || current.command.next_position !== item.position) return 'stale';
            if (current.command.plan_hash !== state.command.plan_hash) return scheduleUnavailable();
            const livePolicy = await ctx.db.one<Policy>("SELECT * FROM retention_settings WHERE id='default'");
            if (!livePolicy || stable(livePolicy) !== stable(state.policy) || livePolicy.legal_hold) return 'deferred_policy';
            await registerScheduleGuard(ctx, actor, () => state.policy);
            const actual = await ctx.db.one<any>('SELECT * FROM assets WHERE id=?', item.asset_id);
            if (!actual || actual.owner_id !== item.owner_id) return 'deferred_source';
            if (actual.version === item.source_version && await digest(stable(actual)) === item.snapshot_hash) return 'ready';
            const rule = await ctx.db.one<{legal_hold:number}>('SELECT legal_hold FROM asset_retention WHERE asset_id=?', item.asset_id);
            if (rule?.legal_hold || await subjectDeletionHold(ctx, item.owner_id) || await mediaHeld(ctx, item.owner_id, item.asset_id)) return 'deferred_hold';
            // The changed snapshot stores no recoverable old key. Any
            // unsettled writer for that subject prevents terminality.
            if (await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1", item.owner_id)) return 'deferred_writer';
            if (actual.version !== item.source_version) return 'replaced';
            supersedingID = await verifiedRawRetirement(ctx, item, actual);
            return supersedingID ? 'already_retired' : 'deferred_source';
        },
        preview: async restore => {
            const identity = await scheduleStepIdentity(actor, state.command, item);
            const jobID = await restoreAllocationID(identity.operation_id, 'id_0');
            restore.operation({ ...identity, allocations: { id_0: jobID } });
            return { operationID: identity.operation_id, jobID };
        },
        finish: async (restore, outcome, operationID) => {
            await requireOperator(ctx, actor, true);
            const current = await scheduleState(ctx, actor, intent, state.command.id);
            if (!current || current.kind !== 'pending' || current.command.next_position !== item.position || current.command.plan_hash !== state.command.plan_hash) return scheduleUnavailable();
            if (outcome === 'replaced' || outcome === 'already_retired') { const identity = await scheduleStepIdentity(actor, current.command, item); restore.operation(identity); operationID = identity.operation_id; }
            if (!operationID || outcome === 'already_retired' && !supersedingID) return scheduleUnavailable();
            await ctx.db.run("UPDATE retention_schedule_items SET outcome=?,completion_id=?,superseding_id=? WHERE command_id=? AND position=? AND outcome='pending' AND completion_id IS NULL AND superseding_id IS NULL",
                outcome, operationID, outcome === 'already_retired' ? supersedingID : null, current.command.id, item.position);
            await ctx.db.run('UPDATE retention_schedule_commands SET next_position=? WHERE id=? AND next_position=?', item.position + 1, current.command.id, item.position);
            const after = await scheduleState(ctx, actor, intent, current.command.id);
            if (!after || after.kind !== 'pending' || after.command.next_position !== item.position + 1 || after.command.plan_hash !== current.command.plan_hash) return scheduleUnavailable();
            await requireOperator(ctx, actor, true);
        },
    });
    if (result === 'conflict') throw new ApiError(503, 'retention_schedule_conflict');
    if (result.startsWith('deferred_')) throw new ApiError(503, 'retention_schedule_' + result);
}
async function finishSchedule(ctx: AppContext, actor: Actor, intent: PreparedOperation, state: Extract<ScheduleState, {kind: 'pending'}>): Promise<Record<string, unknown> | null> {
    return ctx.db.transaction(async restore => {
        await requireOperator(ctx, actor, true);
        const current = await scheduleState(ctx, actor, intent, state.command.id);
        if (!current) return scheduleUnavailable();
        if (current.kind === 'complete') { await registerScheduleGuard(ctx, actor); await requireOperator(ctx, actor, true); return current.response; }
        if (current.command.next_position !== current.command.planned_count) return null;
        await registerScheduleGuard(ctx, actor, () => current.policy);
        const currentPolicy = await policy(ctx);
        if (currentPolicy.legal_hold || stable(currentPolicy) !== stable(current.policy)) throw new ApiError(503, 'retention_schedule_deferred_policy');
        const key = 'retention.finish:' + await digest(stable({ command_id: current.command.id }));
        restore.operation({ operation_id: await restoreOperationID(actor.accountId, 'retention.schedule.finish-v1', key),
            input_hash: await digest(stable({ protocol: 'lovelies-retention-schedule-finish-v1', command_id: current.command.id,
                plan_hash: current.command.plan_hash, input_hash: intent.hash })), allocations: {} });
        await snapshotExpiredProfiles(ctx, current.command.limit_count, current.policy);
        await requireOperator(ctx, actor, true);
        const checked = await scheduleState(ctx, actor, intent, state.command.id);
        if (!checked || checked.kind !== 'pending' || checked.command.next_position !== checked.command.planned_count || checked.command.plan_hash !== current.command.plan_hash) return scheduleUnavailable();
        const policyAfter = await policy(ctx);
        if (policyAfter.legal_hold || stable(policyAfter) !== stable(current.policy)) throw new ApiError(503, 'retention_schedule_deferred_policy');
        const response = { scheduled: true, operation_key: intent.key };
        await ctx.db.run('UPDATE operations SET response_json=? WHERE actor_id=? AND source=? AND operation_key=? AND response_json=?', stable(response),
            actor.accountId, intent.source, intent.key, stable({ protocol: SCHEDULE_PENDING, command_id: current.command.id }));
        const receipt = await ctx.db.one<{response_json: string}>('SELECT response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, intent.source, intent.key);
        if (receipt?.response_json !== stable(response)) return scheduleUnavailable();
        await ctx.db.run('DELETE FROM retention_schedule_commands WHERE id=?', current.command.id);
        await requireOperator(ctx, actor, true);
        return response;
    });
}
/** A retry may rebase the unchanged item list onto a newly authorized current
 * policy. Its old/new plan hashes are bound to one independent operation. */
async function rebaseSchedulePolicy(ctx: AppContext, actor: Actor, intent: PreparedOperation, commandID: string): Promise<ScheduleState> {
    return ctx.db.transaction(async restore => {
        await requireOperator(ctx, actor, true);
        const state = await scheduleState(ctx, actor, intent, commandID);
        if (!state) return scheduleUnavailable();
        if (state.kind === 'complete') { await registerScheduleGuard(ctx, actor); return state; }
        const next = await policy(ctx);
        if (next.legal_hold) throw new ApiError(503, 'retention_schedule_deferred_policy');
        await registerScheduleGuard(ctx, actor, () => next);
        if (stable(next) === stable(state.policy)) return state;
        const nextHash = await schedulePlanHash(intent, state.command.limit_count, next, state.items);
        const key = 'retention.rebase:' + await digest(stable({command_id: commandID, old_plan_hash: state.command.plan_hash, new_plan_hash: nextHash}));
        restore.operation({operation_id: await restoreOperationID(actor.accountId, 'retention.schedule.rebase-v1', key),
            input_hash: await digest(stable({protocol: 'lovelies-retention-schedule-rebase-v1', command_id: commandID,
                old_plan_hash: state.command.plan_hash, new_plan_hash: nextHash})), allocations: {}});
        await ctx.db.run('UPDATE retention_schedule_commands SET policy_json=?,plan_hash=? WHERE id=? AND plan_hash=? AND next_position=?',
            stable(next), nextHash, commandID, state.command.plan_hash, state.command.next_position);
        await requireOperator(ctx, actor, true);
        const after = await scheduleState(ctx, actor, intent, commandID);
        if (!after || after.kind !== 'pending' || after.command.plan_hash !== nextHash || after.command.next_position !== state.command.next_position) return scheduleUnavailable();
        return after;
    });
}
async function runOperatorSchedule(ctx: AppContext, actor: Actor, intent: PreparedOperation, limit: number): Promise<Record<string, unknown>> {
    ctx.db.requireTransactionBoundary();
    const operationID = await restoreOperationID(actor.accountId, intent.source, intent.key);
    const commandID = await restoreAllocationID(operationID, 'id_0');
    let state = await reserveSchedule(ctx, actor, intent, limit, operationID, commandID);
    if (state.kind === 'pending') state = await rebaseSchedulePolicy(ctx, actor, intent, commandID);
    // A concurrent identical request may advance the cursor. Bound retries and
    // leave the reserved plan intact if contention prevents completion.
    for (let attempts = 0; attempts < 500; attempts++) {
        if (state.kind === 'complete') return state.response;
        if (state.command.next_position === state.command.planned_count) {
            const result = await finishSchedule(ctx, actor, intent, state);
            if (result) return result;
        } else await advanceScheduleAsset(ctx, actor, intent, state);
        state = await ctx.db.read(async () => {
            await requireOperator(ctx, actor, true);
            const current = await scheduleState(ctx, actor, intent, commandID);
            if (!current) return scheduleUnavailable();
            await requireOperator(ctx, actor, true);
            return current;
        });
    }
    throw new ApiError(503, 'retention_schedule_retry');
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
    ctx.db.requireTransactionBoundary();
    return ctx.db.invocation(() => runRetentionAtBoundary(ctx, maximum));
}
async function runRetentionAtBoundary(ctx: AppContext, maximum: number): Promise<{ verified: number; pending: number; failed: number }> {
    const metadataFailures = await pruneInactiveProfileMetadata(ctx, maximum);
    // Pruning remains one transaction. The former combined scheduling batch is
    // now ordered per asset so one stable journal operation owns each raw expiry.
    // A later failure can leave earlier asset transactions committed.
    const scanned = await ctx.db.transaction(async () => { await pruneRetainedMetadata(ctx, maximum); return scanExpiredAssets(ctx, maximum); });
    let conflicted = scanned.conflict;
    for (const asset of scanned.assets)
        if (await scheduleExpiredAsset(ctx, scanned.policy, asset) === 'conflict') conflicted = true;
    if (!scanned.policy.legal_hold) await ctx.db.transaction(async () => { await snapshotExpiredProfiles(ctx, maximum, scanned.policy); });
    let verified = 0, failed = metadataFailures;
    for (const row of (await ctx.db.all<Job>(`SELECT j.* FROM retention_jobs j WHERE j.status IN('pending','failed','processing') AND (j.lease_until IS NULL OR j.lease_until<=?)
      AND NOT EXISTS(SELECT 1 FROM retention_settings p WHERE p.id='default' AND j.kind='preview' AND j.policy_version<>p.version)
      AND NOT EXISTS(SELECT 1 FROM retention_jobs first_preview JOIN retention_jobs peer
        ON peer.asset_id=first_preview.asset_id AND peer.object_version=first_preview.object_version AND peer.kind='preview' AND peer.id<>first_preview.id
        WHERE first_preview.asset_id=j.asset_id AND first_preview.object_version=j.object_version AND first_preview.kind='preview')
      AND NOT EXISTS(SELECT 1 FROM retention_jobs preview_job JOIN assets preview_asset
        ON preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
        WHERE preview_job.asset_id=j.asset_id AND preview_job.object_version=j.object_version AND preview_job.kind='preview' AND ${previewInventoryMismatchSQL})
      AND (j.kind<>'raw' OR NOT EXISTS(SELECT 1 FROM retention_jobs preview_job LEFT JOIN assets preview_asset
        ON preview_asset.id=preview_job.asset_id AND preview_asset.version=preview_job.object_version
        WHERE preview_job.asset_id=j.asset_id AND preview_job.object_version=j.object_version AND preview_job.kind='preview' AND ${previewRawBlockSQL}))
      AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.subject_id=j.subject_id AND h.request_type='delete'
        AND h.legal_hold=1 AND h.status NOT IN('completed','rejected','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM retention_settings p WHERE p.id='default' AND p.legal_hold=1)
      AND NOT EXISTS(SELECT 1 FROM asset_retention r WHERE r.asset_id=j.asset_id AND r.legal_hold=1)
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.subject_id=j.subject_id OR h.asset_id=j.asset_id))
      AND NOT EXISTS(SELECT 1 FROM retention_objects o JOIN media_write_intents w ON w.bucket=o.bucket AND w.object_key=o.object_key
        WHERE o.job_id=j.id AND o.status<>'verified' AND w.status='pending')
      AND NOT EXISTS(SELECT 1 FROM retention_objects mine JOIN retention_objects other ON other.bucket=mine.bucket
        AND other.object_key=mine.object_key AND other.job_id<>mine.job_id JOIN retention_jobs peer ON peer.id=other.job_id
        WHERE mine.job_id=j.id AND (peer.status<>'verified' OR other.status<>'verified'))
      AND NOT EXISTS(SELECT 1 FROM retention_jobs first_job WHERE first_job.asset_id=j.asset_id AND first_job.object_version=j.object_version AND first_job.kind='raw'
        AND (EXISTS(SELECT 1 FROM assets a WHERE a.id=first_job.asset_id AND a.version=first_job.object_version AND a.deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM retention_jobs other_job WHERE other_job.asset_id=first_job.asset_id AND other_job.object_version=first_job.object_version
            AND other_job.kind='raw' AND other_job.id<>first_job.id)))
      ORDER BY j.created_at,j.id LIMIT ?`, ctx.now(), maximum))) {
        const lease = crypto.randomUUID(), lateConflict = new Error('retention_claimed_episode_conflict');
        let deleteDispatched = false, freshClaim = false;
        try {
            const claimed = await ctx.db.transaction(async () => {
                const actual = (await ctx.db.one<Job>('SELECT * FROM retention_jobs WHERE id=?', row.id));
                if (!actual || !['pending', 'failed', 'processing'].includes(actual.status) || actual.lease_until !== null && actual.lease_until > ctx.now())
                    throw new ApiError(409, 'retention_job_changed');
                // Recheck after the bounded query before changing status, lease,
                // error or policy; skip every job in a conflicted episode.
                if (await jobEpisodeConflict(ctx, actual) || await jobObjectOverlap(ctx, actual.id)) return 'conflict' as const;
                if (await ctx.db.one(`SELECT o.id FROM retention_objects o JOIN media_write_intents w ON w.bucket=o.bucket AND w.object_key=o.object_key
                  WHERE o.job_id=? AND o.status<>'verified' AND w.status='pending' LIMIT 1`, actual.id)) return 'deferred' as const;
                // Use the state read under the claim transaction, never the
                // earlier scan row, which another worker may have changed.
                freshClaim = actual.status === 'pending' && actual.lease_until === null;
                const p = (await policy(ctx));
                // The policy may change after the page was read. Never relabel
                // or claim an older preview obligation on that basis.
                if (actual.kind === 'preview' && actual.policy_version !== p.version) return 'conflict' as const;
                if (await subjectDeletionHold(ctx, actual.subject_id))
                    throw new ApiError(503, 'retention_request_hold');
                if ((await hold(ctx, actual, p)))
                    throw new ApiError(503, 'retention_on_hold');
                // Preview policy identity is retained. Legacy raw/profile policy
                // handling remains an independently unqualified boundary.
                if (actual.kind === 'preview')
                    (await ctx.db.run("UPDATE retention_jobs SET status='processing',lease_token=?,lease_until=?,error_code=NULL WHERE id=?", lease, ctx.now() + 300000, row.id));
                else
                    (await ctx.db.run("UPDATE retention_jobs SET status='processing',policy_version=?,lease_token=?,lease_until=?,error_code=NULL WHERE id=?", p.version, lease, ctx.now() + 300000, row.id));
                // Validate source under this committed lease immediately before
                // DELETE or finalization, so only this lease can record failure.
                return 'claimed' as const;
            });
            if (claimed !== 'claimed') { if (claimed === 'conflict') conflicted = true; continue; }
            for (const item of (await ctx.db.all<any>("SELECT * FROM retention_objects WHERE job_id=? AND status<>'verified' ORDER BY id LIMIT 500", row.id))) {
                const check = async () => { (await current(ctx, row.id, lease, lateConflict)); if ((await ctx.db.one("SELECT id FROM media_write_intents WHERE bucket=? AND object_key=? AND status='pending' LIMIT 1", item.bucket, item.object_key)))
                    throw new ApiError(503, 'retention_writer_unresolved'); };
                (await ctx.db.transaction(check));
                const bucket = ctx.env[item.bucket as PrivateObject['bucket']];
                deleteDispatched = true;
                await bucket.delete(item.object_key);
                (await ctx.db.transaction(check));
                const remains = await bucket.head(item.object_key);
                (await ctx.db.transaction(async () => { (await check()); if (remains)
                    throw new ApiError(503, 'retention_delete_unconfirmed'); (await ctx.db.run("UPDATE retention_objects SET status='verified',attempts=attempts+1,verified_at=? WHERE id=?", ctx.now(), item.id)); }));
            }
            const finalized = await ctx.db.transaction(async () => {
                (await current(ctx, row.id, lease, lateConflict));
                if ((await ctx.db.one("SELECT id FROM retention_objects WHERE job_id=? AND status<>'verified' LIMIT 1", row.id)))
                    return false;
                // Keep a non-sensitive asset tombstone for exact immutable sharing and
                // financial receipt references. Profile templates have no foreign graph access.
                if (row.kind === 'raw') {
                    await ctx.db.run('UPDATE assets SET title=NULL,captured_at=NULL,width=NULL,height=NULL WHERE id=?',row.asset_id);
                    await ctx.db.run("UPDATE processing_attempts SET profiles_json='[]',matches_json='[]',processor_nonce=NULL,rendition_key=NULL WHERE asset_id=? AND status<>'running'",row.asset_id);
                }
                if (row.kind === 'profile')
                    (await ctx.db.run('DELETE FROM face_profiles WHERE account_id=? AND revision=?', row.subject_id, row.object_version));
                (await ctx.db.run("UPDATE retention_jobs SET status='verified',lease_token=NULL,lease_until=NULL,verified_at=? WHERE id=?", ctx.now(), row.id));
                return true;
            });
            // The callback can finish even when COMMIT or the independent
            // acknowledgment fails. Count only a returned final transaction.
            if (finalized) verified++;
        }
        catch (error) {
            if (error === lateConflict) {
                conflicted = true;
                // If bytes may already have been dispatched, leave the lease and
                // object evidence untouched and stop this retention run.
                if (deleteDispatched) throw new ApiError(503, 'retention_conflict_after_dispatch');
                continue;
            }
            const code = error instanceof ApiError ? error.code : 'retention_storage_failed';
            // In the intact local job lifecycle, a new pending job with no DELETE
            // in this attempt may retry after release. Older retry/expired-lease
            // jobs and any current dispatch need independent reconciliation;
            // this test does not qualify restore or provider terminality.
            const freshUndispatched = freshClaim && !deleteDispatched;
            const blocked = error instanceof ApiError && (error.status === 409 ||
                error.code === 'retention_request_hold' && !freshUndispatched);
            // Only the current, unexpired lease may change job state. A stale
            // scan must never overwrite a successor's verified or blocked job.
            (await ctx.db.run("UPDATE retention_jobs SET status=?,lease_token=NULL,lease_until=NULL,error_code=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?", blocked ? 'blocked' : 'failed', code, row.id, lease, ctx.now()));
            failed++;
        }
    }
    // A conflict can arise after the initial scan even if its asset was later
    // skipped for a hold or changed policy; keep maintenance health nonzero.
    const finalPolicy = await policy(ctx);
    const unresolvedConflict = conflicted || await anyRawConflict(ctx) || await anyPreviewConflict(ctx, finalPolicy) ||
      await anyJobObjectOverlap(ctx) || await anySourceObjectOverlap(ctx, finalPolicy);
    return { verified, pending: (await ctx.db.one<{
            n: number;
        }>("SELECT count(*) n FROM retention_jobs WHERE status<>'verified'"))!.n, failed: failed + (unresolvedConflict ? 1 : 0) };
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
        const receipt = await runOperatorSchedule(ctx, actor, intent, limit);
        return ok(receipt); // Physical cleanup remains the trusted maintenance job's responsibility.
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
    const rows = { asset_retention: (await ctx.db.all('SELECT r.asset_id,r.raw_expires_at,r.preview_expires_at,r.legal_hold FROM asset_retention r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=? ORDER BY r.asset_id LIMIT 25001', subject)), retention_jobs: (await ctx.db.all('SELECT id,asset_id,kind,status,created_at,verified_at,error_code FROM retention_jobs WHERE subject_id=? ORDER BY created_at,id LIMIT 25001', subject)),
        // An accepted bounded schedule may still be pending before a cleanup
        // job exists. Export the subject's own item view without internal plan
        // hashes, operator authority or other owners' selected items.
        retention_schedule_items: (await ctx.db.all(`SELECT i.asset_id,i.source_version,i.outcome,c.created_at
          FROM retention_schedule_items i JOIN retention_schedule_commands c ON c.id=i.command_id
          WHERE i.owner_id=? ORDER BY c.created_at,c.id,i.position LIMIT 25001`, subject)),
        retention_schedule_commands: (await ctx.db.all(`SELECT operation_key,limit_count,planned_count,next_position,created_at
          FROM retention_schedule_commands WHERE actor_id=? ORDER BY created_at,id LIMIT 25001`, subject)),
    };
    if (Object.values(rows).some(items => items.length > 25000))
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
/** Root captures these exact job keys into request-authorized privacy cleanup
 * before deleting the metadata; no foreign profile keys or bucket listing. */
export async function retentionPrivateKeys(db: Database, subject: string): Promise<PrivateObject[]> {
    return (await db.all<PrivateObject>('SELECT DISTINCT o.bucket,o.object_key FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE j.subject_id=?', subject));
}
/** Account erasure uses the same global, asset and moderation hold classes as
 * retention. Keep the owned asset mapping until cleanup finishes: an asset-only
 * hold must remain attributable after the account's ordinary metadata is erased.
 * Versions and cleared hold history make retention-policy and moderation
 * changes during Storage I/O observable without retaining private rationale.
 * Deletion-request holds have no such history here: a hold set and cleared
 * between checks remains an unresolved recovery and concurrency boundary. */
export async function accountErasureHoldFingerprint(ctx: AppContext, subject: string): Promise<string> {
    const global = await ctx.db.one<{ version: number; legal_hold: number }>("SELECT version,legal_hold FROM retention_settings WHERE id='default'");
    const deletionHold = await ctx.db.one(`SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete'
      AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled') LIMIT 1`, subject);
    const assets = await ctx.db.all<{ id: string; version: string }>('SELECT id,version FROM assets WHERE owner_id=? ORDER BY id', subject);
    const rules = await ctx.db.all<{ asset_id: string; version: number; legal_hold: number }>('SELECT r.asset_id,r.version,r.legal_hold FROM asset_retention r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=? ORDER BY r.asset_id', subject);
    const moderation = await ctx.db.all<{ id: string; subject_id: string | null; asset_id: string | null; active: number; created_at: number; cleared_at: number | null }>('SELECT id,subject_id,asset_id,active,created_at,cleared_at FROM moderation_holds WHERE subject_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?) ORDER BY id', subject, subject);
    if (global?.legal_hold || deletionHold || rules.some(row => row.legal_hold) || moderation.some(row => row.active))
        throw new ApiError(409, 'privacy_legal_hold');
    return digest(stable({ global, assets, rules, moderation }));
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
async function privacyOperation(ctx: AppContext, row: StoredOperation, input: Record<string, unknown>, result: Record<string, any>, request: any): Promise<boolean> {
    if (row.action === 'privacy.export.grant') {
        if (request.request_type !== 'export' || row.actor_id !== request.subject_id || input.request_id !== request.id) return false;
        // Do not minimize an unknown or damaged encrypted delivery record.
        // The original key may need to remain available across key rotation.
        try {
            const {receipt}=await verifiedGrantReceipt(ctx,row.actor_id,row.operation_key,row);
            return receipt.request_id === request.id && receipt.account_id === request.subject_id;
        } catch { return false; }
    }
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
/** SQL predicates are fixed application expressions; no user text is interpolated. */
function noCurrentHold(subjectPredicate: string): string {
    return `EXISTS(SELECT 1 FROM retention_settings p WHERE p.id='default' AND p.legal_hold=0)
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (${subjectPredicate}))
      AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.request_type='delete' AND h.legal_hold=1
        AND h.status NOT IN('completed','rejected','cancelled') AND (${subjectPredicate}))`;
}
/** A terminal source is not permission to erase an outstanding writer, cleanup,
 * hold or delivery obligation. No external object or queue row is changed here. */
async function operationRetirementBlocked(ctx: AppContext, subjects: string[], entity: string): Promise<boolean> {
    const global = await ctx.db.one<{legal_hold: number}>("SELECT legal_hold FROM retention_settings WHERE id='default'");
    if (!global || global.legal_hold !== 0) return true;
    for (const subject of new Set(subjects)) {
        if (await subjectDeletionHold(ctx, subject) ||
            await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1', subject) ||
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
    const retire: Array<{row: StoredOperation; subjects: string[]}> = [];
    const directSubjects = [...new Set(link.subjects)];
    if (!directSubjects.length || directSubjects.length > 32) return false;
    const observedSubjects = new Set(directSubjects);
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
        observedSubjects.add(row.actor_id);
        for (const item of related) observedSubjects.add(item.subject_id);
        if (classification !== 'other') retire.push({row, subjects: [...new Set([...directSubjects, row.actor_id, ...related.map(item => item.subject_id)])]});
    }
    // Recheck all previously observed subjects before each mutation. A late
    // hold aborts the whole pruning transaction, including earlier receipts.
    const directPlaceholders = directSubjects.map(() => '?').join(',');
    const receiptSubject = `h.subject_id=operations.actor_id OR h.subject_id IN (${directPlaceholders}) OR EXISTS(
      SELECT 1 FROM operation_subjects os WHERE os.actor_id=operations.actor_id AND os.source=operations.source
      AND os.operation_key=operations.operation_key AND os.subject_id=h.subject_id)`;
    for (const {row, subjects} of retire) {
        if (await operationRetirementBlocked(ctx, subjects, link.entity))
            throw new ApiError(409, 'retention_hold_changed');
        await ctx.db.run(`UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source=? AND operation_key=?
          AND payload_hash=? AND payload_json=? AND response_json=? AND ${noCurrentHold(receiptSubject)}`,
            retiredOperationInput, retiredOperationResponse, row.actor_id, row.source, row.operation_key, row.payload_hash, row.payload_json, row.response_json,
            ...directSubjects, ...directSubjects);
        const current = await ctx.db.one<{payload_json: string; response_json: string}>('SELECT payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', row.actor_id, row.source, row.operation_key);
        if (current?.payload_json !== retiredOperationInput || current.response_json !== retiredOperationResponse)
            throw new ApiError(409, 'retention_operation_changed');
        budget.left--;
    }
    if (await operationRetirementBlocked(ctx, [...observedSubjects], link.entity))
        throw new ApiError(409, 'retention_hold_changed');
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
        if (complete) {
            await ctx.db.run(`DELETE FROM support_requests WHERE id=? AND ${noCurrentHold('h.subject_id=support_requests.account_id')}`, support.id);
            if (await ctx.db.one('SELECT id FROM support_requests WHERE id=?', support.id)) throw new ApiError(409, 'retention_hold_changed');
        }
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
        if (complete) {
            await ctx.db.run(`DELETE FROM guardian_requests WHERE id=? AND ${noCurrentHold("h.subject_id=guardian_requests.child_account_id OR h.subject_id=guardian_requests.guardian_account_id OR h.subject_id=guardian_requests.reviewed_by")}`, guardian.id);
            if (await ctx.db.one('SELECT id FROM guardian_requests WHERE id=?', guardian.id)) throw new ApiError(409, 'retention_hold_changed');
        }
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
            await ctx.db.run(`DELETE FROM audience_adult_reviews WHERE id=? AND ${noCurrentHold('h.subject_id=audience_adult_reviews.account_id OR h.subject_id=audience_adult_reviews.reviewed_by')}`, review.id);
            if (await ctx.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', review.id)) throw new ApiError(409, 'retention_hold_changed');
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
            valid: (row, input, result) => privacyOperation(ctx, row, input, result, request),
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
    await pruneDownloadEvidence(ctx,p.audit_days,maximum);
    await pruneTerminalOperationCopies(ctx, maximum);
    const events = await ctx.db.all<{id:string}>(`SELECT e.id FROM audit_events e
      WHERE e.created_at <= ? - CASE
        WHEN e.action LIKE 'privacy.%' OR e.action LIKE 'guardian.%' OR e.action LIKE 'audience.%' OR e.action LIKE 'consent.%'
          OR e.action LIKE 'face_profile.%' OR e.action LIKE 'admin.%' OR e.action LIKE 'support.%' OR e.action LIKE 'moderation.%'
          OR EXISTS(SELECT 1 FROM accounts admin_actor WHERE admin_actor.id=e.actor_id AND instr(admin_actor.roles_json,'"admin"')>0) THEN ?
        WHEN e.action LIKE 'face.%' OR e.action LIKE 'auth.%' OR e.action LIKE 'session.%' OR e.action LIKE 'device.%' OR e.action LIKE 'security.%' THEN ?
        ELSE ? END
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND (h.subject_id=e.subject_id OR h.subject_id=e.actor_id))
      AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.request_type='delete' AND h.legal_hold=1
        AND h.status NOT IN('completed','rejected','cancelled') AND (h.subject_id=e.subject_id OR h.subject_id=e.actor_id))
      AND NOT EXISTS(SELECT 1 FROM cleanup_intents c WHERE c.subject_id=e.subject_id AND c.status<>'verified')
      ORDER BY e.created_at,e.id LIMIT ?`,ctx.now(),365*DAY,p.audit_days*DAY,7*DAY,maximum);
    for (const event of events) {
        await ctx.db.run(`DELETE FROM audit_events WHERE id=?
          AND ${noCurrentHold('h.subject_id=audit_events.subject_id OR h.subject_id=audit_events.actor_id')}
          AND NOT EXISTS(SELECT 1 FROM cleanup_intents c WHERE c.subject_id=audit_events.subject_id AND c.status<>'verified')`, event.id);
        // A newly visible hold must also roll back earlier pruning in this
        // transaction; silently skipping this row could commit older mutations.
        if (await ctx.db.one('SELECT id FROM audit_events WHERE id=?', event.id))
            throw new ApiError(409, 'retention_hold_changed');
    }
    // These rows contain minimal consent facts already. References held by an
    // active or unresolved operation prevent premature deletion; no FK bypass.
    await ctx.db.run(`DELETE FROM consents WHERE id IN(SELECT c.id FROM consents c
      WHERE (c.revoked_at IS NOT NULL OR c.expires_at IS NOT NULL AND c.expires_at<=?)
      AND EXISTS(SELECT 1 FROM retention_settings p WHERE p.id='default' AND p.legal_hold=0)
      AND coalesce(c.revoked_at,c.expires_at,c.created_at)<=?
      AND NOT EXISTS(SELECT 1 FROM face_profiles f WHERE f.consent_id=c.id OR f.auth_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.face_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM auth_challenges a WHERE a.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_enrollment_intents i WHERE i.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_recovery_keys k WHERE k.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM face_profile_operations o WHERE o.consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM match_origins o WHERE o.matching_consent_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1 AND h.subject_id=c.account_id)
      AND NOT EXISTS(SELECT 1 FROM privacy_requests h WHERE h.subject_id=c.account_id AND h.request_type='delete'
        AND h.legal_hold=1 AND h.status NOT IN('completed','rejected','cancelled'))
      ORDER BY c.created_at,c.id LIMIT ?)`,ctx.now(),ctx.now()-365*DAY,maximum);
    const finalGlobal = await ctx.db.one<{legal_hold: number}>("SELECT legal_hold FROM retention_settings WHERE id='default'");
    if (!finalGlobal || finalGlobal.legal_hold !== 0) throw new ApiError(409, 'retention_hold_changed');
    });
}
