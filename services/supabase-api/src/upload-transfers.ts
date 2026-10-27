import { UploadBodyReader, UPLOAD_BODY_CHUNK_TOTAL_MS, UPLOAD_MAX_SOURCE_BYTES } from './upload-body.ts';
import { ApiError, digest, jsonBody, ok, type Actor, type AppContext } from './types.ts';
import { assertMediaActor, currentAsset, hasConsent, type Asset } from './gallery.ts';
import { beginMediaWrite, completeUndispatchedMediaWrite, executeOperation, prepareOperation, settleMediaWrite } from './operations.ts';
export const UPLOAD_CHUNK_BYTES = 262144;
const TTL = 7 * 24 * 60 * 60000;
type Transfer = {
    asset_id: string;
    expected_sha256: string;
    bytes_received: number;
    state: 'uploading' | 'uploaded' | 'cancelled' | 'failed';
    created_at: number;
    expires_at: number;
    lease_token: string | null;
    lease_until: number | null;
    error_code: string | null;
};
type Chunk = {
    asset_id: string;
    offset_bytes: number;
    byte_size: number;
    sha256: string;
    object_key: string;
};
async function own(ctx: AppContext, actor: Actor, id: string, processing = true): Promise<Asset> {
    (await assertMediaActor(ctx, actor));
    const asset = (await currentAsset(ctx, id));
    if (!asset || asset.owner_id !== actor.accountId || asset.source !== 'personal')
        throw new ApiError(404, 'upload_unavailable');
    if (processing && !(await hasConsent(ctx, actor.accountId, 'photo_processing')))
        throw new ApiError(403, 'processing_consent_required');
    return asset;
}
export async function uploadTransfer(ctx: AppContext, id: string): Promise<Transfer | null> {
    return (await ctx.db.one<Transfer>('SELECT * FROM upload_transfers WHERE asset_id=?', id));
}
/** Owner transfer metadata can be reconciled/cancelled after purpose withdrawal;
 * it never returns source bytes or authorizes assembly/processing. */
export async function uploadStatusAsset(ctx: AppContext, actor: Actor, id: string): Promise<Asset> { return (await own(ctx, actor, id, false)); }
function checksum(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        throw new ApiError(400, 'upload_checksum_required');
    return value;
}
export function validateResumable(payload: Record<string, unknown>): boolean {
    if (payload.resumable == null || payload.resumable === false)
        return false;
    if (payload.resumable !== true)
        throw new ApiError(400, 'invalid_metadata');
    checksum(payload.checksum_sha256);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(payload.content_type)))
        throw new ApiError(415, 'image_required');
    return true;
}
export async function createUploadTransfer(ctx: AppContext, id: string, expected: unknown): Promise<void> {
    (await ctx.db.run("INSERT INTO upload_transfers(asset_id,expected_sha256,state,created_at,expires_at) VALUES(?,?,'uploading',?,?)", id, checksum(expected), ctx.now(), ctx.now() + TTL));
}
function chunkPrefix(asset: Asset): string { return `upload-chunk/${asset.owner_id}/${asset.id}/`; }
function sourcePrefix(asset: Asset): string { return `source/${asset.owner_id}/${asset.id}/${asset.version}/`; }
export async function retireUploadKey(ctx: AppContext, owner: string, key: string): Promise<void> {
    if (!(await ctx.db.one('SELECT id FROM media_write_intents WHERE account_id=? AND bucket=\'QUARANTINE\' AND object_key=?', owner, key)))
        return;
    if (!(await ctx.db.one('SELECT id FROM cleanup_intents WHERE subject_id=? AND bucket=\'QUARANTINE\' AND object_key=? AND request_id IS NULL', owner, key)))
        (await ctx.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)", crypto.randomUUID(), owner, key, ctx.now()));
}
async function retireTransferKeys(ctx: AppContext, asset: Asset, includeSource: boolean): Promise<void> {
    for (const row of (await ctx.db.all<{
        object_key: string;
    }>(`SELECT object_key FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE'
    AND (instr(object_key,?)=1 OR (?=1 AND instr(object_key,?)=1))`, asset.owner_id, chunkPrefix(asset), includeSource ? 1 : 0, sourcePrefix(asset))))
        (await retireUploadKey(ctx, asset.owner_id, row.object_key));
}
async function cleanupPending(ctx: AppContext, asset: Asset): Promise<boolean> {
    return !!(await ctx.db.one(`SELECT id FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND status='pending'
    AND (instr(object_key,?)=1 OR instr(object_key,?)=1) LIMIT 1`, asset.owner_id, chunkPrefix(asset), sourcePrefix(asset))) ||
        !!(await ctx.db.one(`SELECT id FROM cleanup_intents WHERE subject_id=? AND bucket='QUARANTINE' AND status<>'verified'
    AND (instr(object_key,?)=1 OR instr(object_key,?)=1) LIMIT 1`, asset.owner_id, chunkPrefix(asset), sourcePrefix(asset)));
}
async function expire(ctx: AppContext, asset: Asset): Promise<Transfer | null> {
    let transfer = (await uploadTransfer(ctx, asset.id));
    if (transfer?.state === 'uploading' && transfer.expires_at <= ctx.now()) {
        (await ctx.db.run("UPDATE upload_transfers SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='upload_expired' WHERE asset_id=? AND state='uploading'", asset.id));
        (await ctx.db.run("UPDATE assets SET status='cancelled' WHERE id=? AND status='uploading'", asset.id));
        (await retireTransferKeys(ctx, asset, true));
        transfer = (await uploadTransfer(ctx, asset.id));
    }
    return transfer;
}
async function pending(ctx: AppContext, actor: Actor, id: string): Promise<{
    asset: Asset;
    transfer: Transfer;
}> {
    const asset = (await own(ctx, actor, id));
    const transfer = (await expire(ctx, asset));
    if (!transfer)
        throw new ApiError(409, 'upload_not_resumable');
    if (transfer.state === 'cancelled')
        throw new ApiError(409, transfer.error_code === 'upload_expired' ? 'upload_expired' : 'upload_cancelled');
    if (transfer.state === 'failed')
        throw new ApiError(422, transfer.error_code ?? 'upload_failed');
    return { asset, transfer };
}
export async function uploadStatusFields(ctx: AppContext, asset: Asset): Promise<Record<string, unknown>> {
    const transfer = (await expire(ctx, asset));
    return { source: asset.source, upload_batch_id: asset.batch_id, byte_size: asset.byte_size, content_type: asset.content_type, title: asset.title,
        checksum_sha256: transfer?.expected_sha256 ?? asset.checksum_sha256, resumable: !!transfer,
        bytes_received: transfer?.bytes_received ?? (asset.checksum_sha256 ? asset.byte_size : 0),
        maximum_chunk_bytes: UPLOAD_CHUNK_BYTES, expires_at: transfer ? new Date(transfer.expires_at).toISOString() : null,
        transfer_status: transfer?.state ?? (asset.checksum_sha256 ? 'uploaded' : 'uploading'),
        assembly_pending: transfer?.state === 'uploading' && transfer.bytes_received === asset.byte_size,
        cleanup_pending: transfer ? (await cleanupPending(ctx, asset)) : false };
}
function imageMagic(bytes: Uint8Array, mime: string): boolean {
    if (mime === 'image/jpeg')
        return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (mime === 'image/png')
        return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
    return mime === 'image/webp' && bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
}
/** Re-entered by status or exact final-chunk replay after an interrupted assembly. */
export async function assembleUpload(ctx: AppContext, actor: Actor, id: string): Promise<void> {
    const lease = crypto.randomUUID();
    const start = (await ctx.db.transaction(async () => {
        const current = (await pending(ctx, actor, id));
        if (current.transfer.state !== 'uploading' || current.transfer.bytes_received !== current.asset.byte_size)
            return null;
        if (current.transfer.lease_token && (current.transfer.lease_until ?? 0) > ctx.now())
            return null;
        (await ctx.db.run('UPDATE upload_transfers SET lease_token=?,lease_until=? WHERE asset_id=?', lease, ctx.now() + 60000, id));
        return current;
    }));
    if (!start)
        return;
    const valid = async () => {
        const current = (await pending(ctx, actor, id));
        if (current.asset.status !== 'uploading' || current.asset.version !== start.asset.version || current.transfer.lease_token !== lease)
            throw new ApiError(409, 'source_changed');
        return current;
    };
    const bytes = new Uint8Array(start.asset.byte_size);
    let writtenKey: string | null = null;
    try {
        const chunks = (await ctx.db.all<Chunk>('SELECT * FROM upload_chunks WHERE asset_id=? ORDER BY offset_bytes', id));
        let offset = 0;
        for (const chunk of chunks) {
            (await ctx.db.transaction(valid));
            if (chunk.offset_bytes !== offset)
                throw new ApiError(409, 'upload_offset_conflict');
            const object = await ctx.env.QUARANTINE.get(chunk.object_key);
            (await ctx.db.transaction(valid));
            if (!object || object.size !== chunk.byte_size)
                throw new ApiError(503, 'upload_chunk_unavailable');
            const data = new Uint8Array(await object.arrayBuffer());
            try {
                (await ctx.db.transaction(valid));
                if (await digest(data) !== chunk.sha256)
                    throw new ApiError(503, 'upload_chunk_unavailable');
                bytes.set(data, offset);
                offset += data.length;
            }
            finally {
                data.fill(0);
            }
        }
        if (offset !== bytes.length)
            throw new ApiError(409, 'upload_offset_conflict');
        const actual = await digest(bytes);
        (await ctx.db.transaction(valid));
        if (actual !== start.transfer.expected_sha256)
            throw new ApiError(422, 'upload_checksum_mismatch');
        if (!imageMagic(bytes, start.asset.content_type))
            throw new ApiError(415, 'image_invalid');
        writtenKey = sourcePrefix(start.asset) + crypto.randomUUID();
        const write = (await beginMediaWrite(ctx, actor, 'QUARANTINE', writtenKey));
        try {
            await ctx.env.QUARANTINE.put(writtenKey, new Uint8Array(bytes).buffer, { httpMetadata: { contentType: start.asset.content_type },
                customMetadata: { source_version: start.asset.version, source_checksum_sha256: actual, asset_id: id } });
        }
        finally {
            (await settleMediaWrite(ctx, write));
        }
        (await ctx.db.transaction(async () => {
            (await valid());
            (await ctx.db.run("UPDATE assets SET status='uploaded',checksum_sha256=?,object_key=? WHERE id=?", actual, writtenKey, id));
            (await ctx.db.run("UPDATE upload_transfers SET state='uploaded',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE asset_id=?", id));
            (await retireTransferKeys(ctx, start.asset, false));
            (await assertMediaActor(ctx, actor));
        }));
        writtenKey = null;
    }
    catch (error) {
        (await ctx.db.transaction(async () => {
            const current = (await uploadTransfer(ctx, id));
            if (current?.lease_token === lease) {
                if (error instanceof ApiError && ['upload_checksum_mismatch', 'image_invalid'].includes(error.code)) {
                    (await ctx.db.run("UPDATE upload_transfers SET state='failed',error_code=? WHERE asset_id=?", error.code, id));
                    (await ctx.db.run("UPDATE assets SET status='failed' WHERE id=? AND status='uploading'", id));
                    (await retireTransferKeys(ctx, start.asset, true));
                }
                (await ctx.db.run('UPDATE upload_transfers SET lease_token=NULL,lease_until=NULL WHERE asset_id=?', id));
            }
        }));
        throw error;
    }
    finally {
        bytes.fill(0);
        if (writtenKey)
            (await ctx.db.transaction(async () => (await retireUploadKey(ctx, start.asset.owner_id, writtenKey!))));
    }
}
export async function uploadChunk(request: Request, ctx: AppContext, actor: Actor, id: string): Promise<Response> {
    const url = new URL(request.url), offsetText = url.searchParams.get('offset');
    if (!offsetText || !/^(0|[1-9][0-9]{0,8})$/.test(offsetText) || [...url.searchParams.keys()].some(key => key !== 'offset'))
        throw new ApiError(400, 'upload_offset_invalid');
    const offset = Number(offsetText), hash = checksum(request.headers.get('X-Lovelies-Chunk-SHA256'));
    const initial = (await ctx.db.transaction(async () => (await pending(ctx, actor, id))));
    if (request.headers.get('content-type') !== initial.asset.content_type)
        throw new ApiError(415, 'image_required');
    if (!Number.isSafeInteger(initial.asset.byte_size) || initial.asset.byte_size < 1 || initial.asset.byte_size > UPLOAD_MAX_SOURCE_BYTES)
        throw new ApiError(413, 'image_too_large');
    if (offset >= initial.asset.byte_size || offset % UPLOAD_CHUNK_BYTES !== 0)
        throw new ApiError(409, 'upload_offset_conflict');
    const expected = Math.min(UPLOAD_CHUNK_BYTES, initial.asset.byte_size - offset);
    const bytes = new Uint8Array(expected);
    const reader = new UploadBodyReader(request, UPLOAD_BODY_CHUNK_TOTAL_MS);
    let size = 0, writtenKey: string | null = null;
    try {
        for (;;) {
            const next = await reader.readInto(bytes, size, 'upload_chunk_too_large');
            (await ctx.db.transaction(async () => (await pending(ctx, actor, id))));
            reader.guard();
            if (next.done)
                break;
            size += next.length;
        }
        if (size !== expected)
            throw new ApiError(400, 'upload_chunk_size_mismatch');
        if (await digest(bytes) !== hash)
            throw new ApiError(400, 'upload_chunk_checksum_mismatch');
        const replay = (await ctx.db.transaction(async () => {
            const current = (await pending(ctx, actor, id));
            const previous = (await ctx.db.one<Chunk>('SELECT * FROM upload_chunks WHERE asset_id=? AND offset_bytes=?', id, offset));
            if (previous) {
                if (previous.sha256 !== hash || previous.byte_size !== size)
                    throw new ApiError(409, 'upload_offset_conflict');
                return true;
            }
            if (current.transfer.state !== 'uploading' || current.asset.status !== 'uploading' || current.transfer.bytes_received !== offset)
                throw new ApiError(409, 'upload_offset_conflict');
            return false;
        }));
        reader.guard();
        if (!replay) {
            const uploadBytes = new Uint8Array(bytes).buffer;
            const options = { httpMetadata: { contentType: initial.asset.content_type },
                customMetadata: { asset_id: id, source_version: initial.asset.version, offset: String(offset), sha256: hash } };
            reader.guard();
            const candidateKey = chunkPrefix(initial.asset) + offset + '/' + crypto.randomUUID();
            const write = (await beginMediaWrite(ctx, actor, 'QUARANTINE', candidateKey));
            writtenKey = candidateKey;
            try {
                reader.guard();
            }
            catch (error) {
                // No PUT has been invoked; do not queue cleanup for this key.
                writtenKey = null;
                await completeUndispatchedMediaWrite(ctx, write);
                throw error;
            }
            await ctx.env.QUARANTINE.put(candidateKey, uploadBytes, options);
            (await settleMediaWrite(ctx, write));
            (await ctx.db.transaction(async () => {
                const current = (await pending(ctx, actor, id));
                const winner = (await ctx.db.one<Chunk>('SELECT * FROM upload_chunks WHERE asset_id=? AND offset_bytes=?', id, offset));
                if (winner) {
                    if (winner.sha256 !== hash || winner.byte_size !== size)
                        throw new ApiError(409, 'upload_offset_conflict');
                    (await retireUploadKey(ctx, actor.accountId, writtenKey!));
                    return;
                }
                if (current.transfer.state !== 'uploading' || current.asset.status !== 'uploading' || current.transfer.bytes_received !== offset || current.asset.version !== initial.asset.version)
                    throw new ApiError(409, 'upload_offset_conflict');
                (await ctx.db.run('INSERT INTO upload_chunks(asset_id,offset_bytes,byte_size,sha256,object_key) VALUES(?,?,?,?,?)', id, offset, size, hash, writtenKey));
                (await ctx.db.run('UPDATE upload_transfers SET bytes_received=? WHERE asset_id=?', offset + size, id));
                (await assertMediaActor(ctx, actor));
            }));
            writtenKey = null;
        }
        await assembleUpload(ctx, actor, id);
        return ok((await ctx.db.transaction(async () => {
            const current = (await pending(ctx, actor, id));
            return { asset_id: id, version: current.asset.version, status: current.asset.status,
                ...(await uploadStatusFields(ctx, current.asset)), processing_creates_access: false };
        })));
    }
    finally {
        bytes.fill(0);
        reader.close();
        if (writtenKey)
            (await ctx.db.transaction(async () => (await retireUploadKey(ctx, actor.accountId, writtenKey!))));
    }
}
export async function cancelUpload(request: Request, ctx: AppContext, actor: Actor, id: string): Promise<Response> {
    const body = await jsonBody(request);
    if (Object.keys(body).some(k => k !== 'operation_key'))
        throw new ApiError(400, 'invalid_metadata');
    const intent = await prepareOperation('photo.upload.cancel', { ...body, asset_id: id }, 'personal');
    const receipt = (await executeOperation(ctx, actor, intent, async () => {
        const asset = (await own(ctx, actor, id, false));
        const transfer = (await uploadTransfer(ctx, id));
        if (!transfer)
            throw new ApiError(409, 'upload_not_resumable');
        if (['processing', 'ready'].includes(asset.status) || transfer.state === 'uploaded' && asset.status !== 'uploaded')
            throw new ApiError(409, 'upload_already_processing');
        (await ctx.db.run("UPDATE upload_transfers SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code=COALESCE(error_code,'upload_cancelled') WHERE asset_id=?", id));
        (await ctx.db.run("UPDATE assets SET status='cancelled' WHERE id=?", id));
        (await retireTransferKeys(ctx, asset, true));
        return { asset_id: id, version: asset.version, status: 'cancelled', processing_creates_access: false };
    }));
    return ok((await ctx.db.transaction(async () => {
        const asset = (await own(ctx, actor, id, false));
        return { ...receipt, ...(await uploadStatusFields(ctx, asset)) };
    })));
}
export async function expireUploads(ctx: AppContext): Promise<void> {
    (await ctx.db.transaction(async () => {
        for (const asset of (await ctx.db.all<Asset>(`SELECT a.* FROM assets a JOIN upload_transfers t ON t.asset_id=a.id WHERE t.state='uploading' AND t.expires_at<=? LIMIT 100`, ctx.now())))
            (await expire(ctx, asset));
    }));
}
export async function nextUploadAt(ctx: AppContext): Promise<number | null> {
    return (await ctx.db.one<{
        due: number | null;
    }>("SELECT MIN(expires_at) due FROM upload_transfers WHERE state='uploading'"))?.due ?? null;
}
