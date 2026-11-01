import { assertPrivacyActor } from './auth.ts';
import { bindPrivacyGrantAuthority, type PrivacyGrantGuard } from './privacy-authority.ts';
import { executeRestrictedOperation, prepareOperation } from './operations.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { readPrivateBytes } from './private-body.ts';
import { EXPORT_CHUNK_BYTES, EXPORT_MANIFEST_PAGE, exportManifestSeed, exportManifestNext, scheduleExportChunkCleanup, type ExportChunk } from './privacy-export-chunks.ts';

const protocol = 'lovelies-privacy-export-delivery-v2';
const maximumBytes = 20 * 1024 * 1024;
type Delivery = { id: string; request_id: string; subject_id: string; session_id: string; publication_id: string;
    operation_key: string; sha256: string; bytes: number; expires_at: number; created_at: number; acknowledged_at: number | null;
    protocol_version: number; chunk_count: number; manifest_sha256: string | null };
type Publication = { id: string; request_id: string; subject_id: string; object_key: string; sha256: string; bytes: number; expires_at: number; status: string;
    content_format: string; chunk_count: number; manifest_sha256: string | null };
const unavailable = (): never => { throw new ApiError(404, 'privacy_export_delivery_unavailable'); };
function exact(body: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw new ApiError(400, 'invalid_input');
}
async function current(ctx: AppContext, actor: Actor, id: string, available: boolean): Promise<{ delivery: Delivery; publication: Publication }> {
    await assertPrivacyActor(actor, ctx);
    const delivery = await ctx.db.one<Delivery>('SELECT * FROM privacy_export_deliveries WHERE id=? AND subject_id=?', id, actor.accountId);
    if (!delivery) return unavailable();
    if (delivery.session_id !== actor.sessionId) throw new ApiError(409, 'privacy_export_delivery_session_changed');
    if (![2,3].includes(delivery.protocol_version) || !Number.isSafeInteger(delivery.bytes) || delivery.bytes < 1 ||
        delivery.protocol_version === 2 && (delivery.bytes > maximumBytes || delivery.chunk_count !== 0 || delivery.manifest_sha256 !== null) ||
        delivery.protocol_version === 3 && (!Number.isSafeInteger(delivery.chunk_count) || delivery.chunk_count !== Math.ceil(delivery.bytes / EXPORT_CHUNK_BYTES) || !/^[0-9a-f]{64}$/.test(delivery.manifest_sha256 ?? '')) ||
        !/^[0-9a-f]{64}$/.test(delivery.sha256) ||
        !Number.isSafeInteger(delivery.expires_at) || delivery.expires_at <= delivery.created_at || delivery.expires_at > delivery.created_at + (delivery.protocol_version === 2 ? 300000 : 3600000) ||
        delivery.acknowledged_at !== null && (!Number.isSafeInteger(delivery.acknowledged_at) || delivery.acknowledged_at < delivery.created_at))
        throw new ApiError(503, 'privacy_export_delivery_unverified');
    const publication = await ctx.db.one<Publication>('SELECT * FROM privacy_exports WHERE id=?', delivery.publication_id);
    const request = await ctx.db.one<{ subject_id: string; request_type: string; status: string; export_key: string; export_sha256: string; export_bytes: number; export_expires_at: number }>('SELECT subject_id,request_type,status,export_key,export_sha256,export_bytes,export_expires_at FROM privacy_requests WHERE id=?', delivery.request_id);
    if (!publication || !request || request.subject_id !== actor.accountId || request.request_type !== 'export' || request.status !== 'completed' ||
        publication.subject_id !== actor.accountId || publication.request_id !== delivery.request_id || publication.object_key !== request.export_key ||
        publication.sha256 !== delivery.sha256 || request.export_sha256 !== delivery.sha256 || publication.bytes !== delivery.bytes || request.export_bytes !== delivery.bytes ||
        publication.expires_at < delivery.expires_at || publication.content_format !== (delivery.protocol_version === 2 ? 'flat' : 'chunked') ||
        publication.chunk_count !== delivery.chunk_count || publication.manifest_sha256 !== delivery.manifest_sha256) return unavailable();
    if (available && (delivery.acknowledged_at !== null || delivery.expires_at <= ctx.now() || publication.status !== 'published' || request.export_expires_at <= ctx.now()))
        throw new ApiError(410, 'privacy_export_delivery_expired');
    await assertPrivacyActor(actor, ctx);
    return { delivery, publication };
}
function projection(row: Delivery): Record<string, unknown> {
    return { protocol: row.protocol_version === 2 ? protocol : 'lovelies-privacy-export-delivery-v3', operation_key: row.operation_key, request_id: row.request_id, delivery_id: row.id, account_id: row.subject_id,
        session_id: row.session_id, state: row.acknowledged_at === null ? 'available' : 'acknowledged',
        expires_at: new Date(row.expires_at).toISOString(), sha256: row.sha256, bytes: row.bytes,
        retrieve_path: `/privacy-exports/deliveries/${row.id}${row.protocol_version === 3 ? '/manifest?offset=0' : ''}`, ack_path: `/privacy-exports/deliveries/${row.id}/ack`,
        ...(row.protocol_version === 3 ? { publication_id: row.publication_id, chunk_count: row.chunk_count, chunk_bytes: EXPORT_CHUNK_BYTES, manifest_sha256: row.manifest_sha256 } : {}) };
}
function protect(ctx: AppContext, actor: Actor, row: Delivery, guard: PrivacyGrantGuard, available: boolean): void {
    const snapshot = stable(row);
    guard.protect(async () => {
        if (stable((await current(ctx, actor, row.id, available)).delivery) !== snapshot) throw new ApiError(409, 'privacy_export_delivery_changed');
    }, available ? row.expires_at : undefined);
}
/** One session-bound logical delivery can be read again after transport loss.
 * It is retired only after the client acknowledges durably staged, verified
 * bytes. The legacy one-use capability route is intentionally unchanged. */
export async function handleExportDelivery(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url), create = /^\/privacy-exports\/([0-9a-f-]{36})\/deliveries$/.exec(url.pathname),
        target = /^\/privacy-exports\/deliveries\/([0-9a-f-]{36})(?:\/(ack|manifest|chunks\/(?:0|[1-9][0-9]*)))?$/.exec(url.pathname);
    if (!create && !target) return null;
    if (url.search && target?.[2] !== 'manifest' || request.method !== (create || target?.[2] === 'ack' ? 'POST' : 'GET')) throw new ApiError(405, 'method_not_allowed');
    const actor = await ctx.authenticate(request), guard = bindPrivacyGrantAuthority(ctx, actor);
    await assertPrivacyActor(actor, ctx);
    if (create) {
        const body = await jsonBody(request, 1024); exact(body, ['operation_key']);
        const requestId = uuid(create[1]), intent = await prepareOperation('privacy.export.delivery.create',
            { ...body, protocol, request_id: requestId, session_id: actor.sessionId }, 'privacy');
        const result = await executeRestrictedOperation(ctx, actor, intent, async () => {
            const publication = await ctx.db.one<Publication & { current_expires_at: number }>(`SELECT e.*,r.export_expires_at current_expires_at FROM privacy_exports e JOIN privacy_requests r ON r.id=e.request_id
                WHERE r.id=? AND r.subject_id=? AND r.request_type='export' AND r.status='completed' AND r.export_key=e.object_key
                AND r.export_sha256=e.sha256 AND r.export_bytes=e.bytes AND r.export_expires_at>? AND e.status='published' AND e.expires_at>?`, requestId, actor.accountId, ctx.now(), ctx.now());
            if (!publication) return unavailable();
            const active = (await ctx.db.one<{ n: number }>('SELECT count(*) n FROM privacy_export_deliveries WHERE subject_id=? AND acknowledged_at IS NULL AND expires_at>?', actor.accountId, ctx.now()))!.n;
            if (active >= 10) throw new ApiError(429, 'privacy_export_delivery_limit');
            if (!['flat','chunked'].includes(publication.content_format)) throw new ApiError(503, 'privacy_export_delivery_unverified');
            const version = publication.content_format === 'chunked' ? 3 : 2, session = await ctx.db.one<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE id=? AND account_id=?', actor.sessionId, actor.accountId);
            if (!session || !Number.isSafeInteger(session.expires_at)) throw new ApiError(503, 'privacy_export_delivery_unverified');
            const id = crypto.randomUUID(), now = ctx.now(), expires = Math.min(now + (version === 3 ? 3600000 : 300000), publication.expires_at, publication.current_expires_at, session.expires_at);
            if (expires <= now) throw new ApiError(410, 'privacy_export_delivery_expired');
            await ctx.db.run(`INSERT INTO privacy_export_deliveries(id,request_id,subject_id,session_id,publication_id,operation_key,sha256,bytes,expires_at,created_at,protocol_version,chunk_count,manifest_sha256)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, requestId, actor.accountId, actor.sessionId, publication.id, intent.key, publication.sha256, publication.bytes, expires, now, version, publication.chunk_count, publication.manifest_sha256);
            return { delivery_id: id };
        });
        return ok(await ctx.db.read(async () => {
            const { delivery } = await current(ctx, actor, uuid(result.delivery_id), false);
            if (delivery.request_id !== requestId || delivery.operation_key !== intent.key) throw new ApiError(503, 'privacy_export_delivery_unverified');
            if (delivery.acknowledged_at === null) await current(ctx, actor, delivery.id, true);
            protect(ctx, actor, delivery, guard, delivery.acknowledged_at === null);
            return projection(delivery);
        }));
    }
    const id = uuid(target![1]);
    if (target![2] === 'ack') {
        const body = await jsonBody(request, 1024); exact(body, ['operation_key', 'sha256']);
        if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new ApiError(400, 'invalid_export_digest');
        const intent = await prepareOperation('privacy.export.delivery.ack', { ...body, protocol, delivery_id: id, session_id: actor.sessionId }, 'privacy');
        const result = await executeRestrictedOperation(ctx, actor, intent, async () => {
            const { delivery, publication } = await current(ctx, actor, id, false);
            if (delivery.sha256 !== body.sha256) throw new ApiError(409, 'privacy_export_digest_changed');
            const now = ctx.now();
            await ctx.db.run('UPDATE privacy_export_deliveries SET acknowledged_at=coalesce(acknowledged_at,?) WHERE id=?', now, id);
            await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE id=?", publication.id);
            await ctx.db.run('UPDATE privacy_requests SET export_expires_at=least(export_expires_at,?) WHERE id=? AND export_key=?', now, delivery.request_id, publication.object_key);
            await ctx.db.run("INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,?,'PRIVACY_EXPORTS',?,'pending',?) ON CONFLICT(request_id,bucket,object_key) DO NOTHING", crypto.randomUUID(), delivery.request_id, actor.accountId, publication.object_key, now);
            await scheduleExportChunkCleanup(ctx, publication.id, delivery.request_id, actor.accountId);
            await ctx.db.run("UPDATE privacy_export_snapshots SET status='retired',hash_state_json='{}' WHERE id=?", publication.id);
            await ctx.db.run('DELETE FROM privacy_export_snapshot_rows WHERE snapshot_id=?', publication.id);
            return { acknowledged: true, delivery_id: id, request_id: delivery.request_id };
        });
        await ctx.db.read(async () => {
            const { delivery } = await current(ctx, actor, id, false);
            if (delivery.acknowledged_at === null || delivery.sha256 !== body.sha256) throw new ApiError(503, 'privacy_export_delivery_unverified');
            protect(ctx, actor, delivery, guard, false);
        });
        return ok(result);
    }
    const first = await ctx.db.read(async () => {
        const value = await current(ctx, actor, id, true); protect(ctx, actor, value.delivery, guard, true); return value;
    });
    if (target![2] === 'manifest') {
        if (first.delivery.protocol_version !== 3 || [...url.searchParams.keys()].some(key => key !== 'offset') || url.searchParams.getAll('offset').length !== 1 || !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get('offset') ?? ''))
            throw new ApiError(400, 'privacy_export_manifest_invalid');
        const offset = Number(url.searchParams.get('offset'));
        if (!Number.isSafeInteger(offset) || offset % EXPORT_MANIFEST_PAGE || offset >= first.delivery.chunk_count) throw new ApiError(400, 'privacy_export_manifest_invalid');
        const value = await ctx.db.read(async () => {
            const rows = await ctx.db.all<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index>=? ORDER BY chunk_index LIMIT ?', first.publication.id, offset, EXPORT_MANIFEST_PAGE);
            if (rows.length !== Math.min(EXPORT_MANIFEST_PAGE, first.delivery.chunk_count - offset)) throw new ApiError(503, 'privacy_export_manifest_unverified');
            const previous = offset ? await ctx.db.one<{ root_sha256: string }>('SELECT root_sha256 FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=? AND status=?', first.publication.id, offset - 1, 'verified') : null;
            const previousRoot = offset ? previous?.root_sha256 : await exportManifestSeed(first.publication.id);
            if (!previousRoot || !/^[0-9a-f]{64}$/.test(previousRoot)) throw new ApiError(503, 'privacy_export_manifest_unverified');
            let root = previousRoot; const chunks:Record<string, unknown>[] = [];
            for (let i=0;i<rows.length;i++) {
                const row = rows[i], index = offset + i, expectedBytes = index === first.delivery.chunk_count - 1 ? first.delivery.bytes - index * EXPORT_CHUNK_BYTES : EXPORT_CHUNK_BYTES;
                if (row.chunk_index !== index || row.status !== 'verified' || row.bytes !== expectedBytes || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new ApiError(503, 'privacy_export_manifest_unverified');
                root = await exportManifestNext(root, index, row.bytes, row.sha256);
                if (root !== row.root_sha256) throw new ApiError(503, 'privacy_export_manifest_unverified');
                chunks.push({ index, bytes:row.bytes, sha256:row.sha256, root_sha256:root, retrieve_path:`/privacy-exports/deliveries/${id}/chunks/${index}` });
            }
            const next = offset + rows.length;
            if (next === first.delivery.chunk_count && root !== first.delivery.manifest_sha256) throw new ApiError(503, 'privacy_export_manifest_unverified');
            if (stable(await current(ctx, actor, id, true)) !== stable(first)) throw new ApiError(409, 'privacy_export_delivery_changed');
            return { protocol:'lovelies-privacy-export-manifest-v1', publication_id:first.publication.id, total_bytes:first.delivery.bytes, sha256:first.delivery.sha256,
                chunk_count:first.delivery.chunk_count, chunk_bytes:EXPORT_CHUNK_BYTES, manifest_sha256:first.delivery.manifest_sha256, offset, next_offset:next < first.delivery.chunk_count ? next : null, previous_root:previousRoot, chunks };
        });
        return ok(value);
    }
    if (target![2]?.startsWith('chunks/')) {
        const index = Number(target![2].slice(7));
        if (first.delivery.protocol_version !== 3 || !Number.isSafeInteger(index) || index >= first.delivery.chunk_count) throw new ApiError(404, 'privacy_export_chunk_unavailable');
        const chunk = await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=? AND status=?', first.publication.id, index, 'verified');
        const expected = index === first.delivery.chunk_count - 1 ? first.delivery.bytes - index * EXPORT_CHUNK_BYTES : EXPORT_CHUNK_BYTES;
        if (!chunk || chunk.bytes !== expected || !/^[0-9a-f]{64}$/.test(chunk.sha256)) throw new ApiError(503, 'privacy_export_chunk_unverified');
        let bytes:Uint8Array | undefined;
        try {
            const object = await ctx.env.PRIVACY_EXPORTS.get(chunk.object_key);
            if (!object || object.size !== chunk.bytes) throw new ApiError(503, 'privacy_export_chunk_unverified');
            bytes = await readPrivateBytes(object.body, chunk.bytes, EXPORT_CHUNK_BYTES, request.signal);
            if (await digest(bytes) !== chunk.sha256) throw new ApiError(503, 'privacy_export_chunk_unverified');
            await ctx.db.read(async () => {
                if (stable(await current(ctx, actor, id, true)) !== stable(first) || stable(await ctx.db.one<ExportChunk>('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=? AND status=?', first.publication.id, index, 'verified')) !== stable(chunk))
                    throw new ApiError(409, 'privacy_export_delivery_changed');
            });
            return new Response(bytes.slice().buffer, { headers: {'Content-Type':'application/octet-stream','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','X-Lovelies-Privacy-Export':'lovelies-privacy-export-delivery-v3','X-Lovelies-Export-Sha256':chunk.sha256,'X-Lovelies-Export-Chunk-Index':String(index)} });
        } finally { bytes?.fill(0); }
    }
    if (first.delivery.protocol_version !== 2) throw new ApiError(409, 'privacy_export_requires_chunked_delivery');
    let bytes: Uint8Array | undefined;
    try {
        const object = await ctx.env.PRIVACY_EXPORTS.get(first.publication.object_key);
        if (!object || object.size !== first.delivery.bytes || object.size > maximumBytes) throw new ApiError(503, 'privacy_export_unverified');
        bytes = await readPrivateBytes(object.body, first.delivery.bytes, maximumBytes, request.signal);
        if (bytes.byteLength !== first.delivery.bytes || await digest(bytes) !== first.delivery.sha256) throw new ApiError(503, 'privacy_export_unverified');
        await ctx.db.read(async () => {
            const last = await current(ctx, actor, id, true);
            if (stable(last) !== stable(first)) throw new ApiError(409, 'privacy_export_delivery_changed');
        });
        return new Response(bytes.slice().buffer, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private',
            'X-Content-Type-Options': 'nosniff', 'X-Lovelies-Privacy-Export': protocol, 'X-Lovelies-Export-Sha256': first.delivery.sha256 } });
    } finally { bytes?.fill(0); }
}
