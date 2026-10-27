import { UploadBodyReader, UPLOAD_BODY_SOURCE_TOTAL_MS, UPLOAD_MAX_SOURCE_BYTES } from './upload-body.ts';
import { audienceContext, assertAudienceCapability } from './audience.ts';
import { accountRoles } from './auth.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { assertMediaActor, currentAsset, hasConsent, currentPhotoPolicy, mediaSource, sourceAllowed, type Asset, type MediaSource } from './gallery.ts';
import { beginMediaWrite, completeUndispatchedMediaWrite, executeOperation, executeUploadReservationOperation, prepareOperation, settleMediaWrite } from './operations.ts';
import { assembleUpload, cancelUpload, createUploadTransfer, uploadChunk, uploadStatusAsset, uploadStatusFields, uploadTransfer, validateResumable } from './upload-transfers.ts';
import { selectedGeneration, assertGeneration } from './inference-generation.ts';
const MAX_SOURCE_BYTES = UPLOAD_MAX_SOURCE_BYTES;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
type CapturedProfile = {
    profile_id: string;
    account_id: string;
    revision: string;
    model_id: string;
    template_key: string;
    template_digest: string;
    matching_consent_id: string;
    audience_context: string;
};
type Attempt = {
    id: string;
    asset_id: string;
    source_version: string;
    source_checksum_sha256: string;
    model_version: string;
    engine_identity: string | null;
    status: string;
    captured_at: number;
    expires_at: number;
    owner_id: string;
    owner_session_id: string;
    owner_auth_epoch: number;
    source: MediaSource;
    profiles_json: string;
    processor_nonce: string;
    lease_token: string | null;
    lease_until: number | null;
};
type CanonicalProfile = { profile: CapturedProfile; canonical: string };
function canonicalProfiles(values: CapturedProfile[]): Map<string, CanonicalProfile> {
    if (!Array.isArray(values) || values.length > 1000)
        throw new ApiError(409, 'matching_scope_too_large');
    const byAccount = new Map<string, CanonicalProfile>();
    for (const profile of values) {
        if (!profile || typeof profile.account_id !== 'string' || byAccount.has(profile.account_id))
            throw new ApiError(409, 'matching_profile_changed');
        byAccount.set(profile.account_id, { profile, canonical: stable(profile) });
    }
    return byAccount;
}
async function processorFailureCode(provider: Response, assertAuthority: () => Promise<void>): Promise<string | null> {
    if (provider.status !== 409 || provider.redirected || !provider.body || provider.body.locked ||
        !/^application\/json(?:;|$)/i.test(provider.headers.get('content-type') ?? '')) {
        void provider.body?.cancel().catch(() => { });
        return null;
    }
    const reader = provider.body.getReader(), bytes = new Uint8Array(1024);
    let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('processor_failure_timeout')), 5000); });
    try {
        for (;;) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await Promise.race([reader.read(), deadline]); }
            catch {
                await assertAuthority();
                return null;
            }
            const chunk = next.value;
            try {
                await assertAuthority();
                if (next.done)
                    break;
                if (!(chunk instanceof Uint8Array) || chunk.byteLength > bytes.length - length)
                    return null;
                bytes.set(chunk, length);
                length += chunk.byteLength;
            }
            finally { if (chunk instanceof Uint8Array) chunk.fill(0); }
        }
        let value: string;
        try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
        catch { return null; }
        // Only the adapter's exact bounded envelope is authoritative. Parsing
        // arbitrary JSON would also admit duplicate keys and extra private data.
        return ['registered_reference_space_incompatible', 'inference_generation_changed']
            .find(code => value === JSON.stringify({ error: { code } })) ?? null;
    }
    finally {
        bytes.fill(0);
        clearTimeout(timer);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function imageType(type: unknown): string {
    if (typeof type !== 'string' || !/^image\/(jpeg|png|webp)$/.test(type))
        throw new ApiError(415, 'image_required');
    return type;
}
function imageMagic(bytes: Uint8Array, type: string): boolean {
    if (type === 'image/jpeg')
        return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === 'image/png')
        return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    return bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
}
function positive(value: unknown, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
        throw new ApiError(400, 'invalid_metadata');
    return value as number;
}
async function sourceAsset(ctx: AppContext, actor: Actor, id: string): Promise<Asset> {
    (await assertMediaActor(ctx, actor));
    const asset = (await currentAsset(ctx, id));
    if (!asset || asset.owner_id !== actor.accountId || !sourceAllowed(actor, asset))
        throw new ApiError(404, 'upload_unavailable');
    if (!(await hasConsent(ctx, actor.accountId, 'photo_processing')))
        throw new ApiError(403, 'processing_consent_required');
    return asset;
}
type PreferencePurpose = 'photo_processing' | 'photo_matching';
type PreferenceField = 'processing_consent' | 'photo_matching_consent';
type PreferenceConsent = { account_id: string; id: string; purpose: string };
type PreferenceSharingRequest = { id: string; sender_id: string; recipient_id: string };
type PreferencePurposePlan = { field: PreferenceField; purpose: PreferencePurpose; changed: boolean; withdrawn: PreferenceConsent[] };
type PreferencePlan = { purposes: PreferencePurposePlan[]; recipientRequests: PreferenceSharingRequest[]; ownerRequests: PreferenceSharingRequest[] };
type PreferenceRestrictionFact = { kind: 'consent-withdrawn' | 'sharing-request-retired'; scope: Record<string, string> };
async function preferenceConsentChanged(ctx: AppContext, account: string, purpose: PreferencePurpose,
    granted: unknown, policy: unknown): Promise<boolean> {
    const current = await ctx.db.one<{ id: string; policy_version: string }>(`SELECT id,policy_version FROM consents
        WHERE account_id=? AND purpose=? AND status='granted' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC,id LIMIT 1`, account, purpose, ctx.now());
    return !(granted && current?.policy_version === policy);
}
const preferenceGrantedConsents = (ctx: AppContext, account: string, purpose: PreferencePurpose) =>
    ctx.db.all<PreferenceConsent>("SELECT account_id,id,purpose FROM consents WHERE account_id=? AND purpose=? AND status='granted' ORDER BY id", account, purpose);
const preferenceSharingRequests = (ctx: AppContext, account: string, direction: 'sender_id' | 'recipient_id') =>
    ctx.db.all<PreferenceSharingRequest>(`SELECT id,sender_id,recipient_id FROM sharing_requests WHERE ${direction}=? AND status='accepted' ORDER BY id`, account);
async function preferencePlan(ctx: AppContext, account: string, payload: Record<string, unknown>): Promise<PreferencePlan> {
    const purposes: PreferencePurposePlan[] = [];
    for (const [field, purpose] of [['processing_consent', 'photo_processing'], ['photo_matching_consent', 'photo_matching']] as const) {
        if (payload[field] == null) continue;
        const changed = await preferenceConsentChanged(ctx, account, purpose, payload[field], payload.policy_version);
        purposes.push({ field, purpose, changed, withdrawn: changed ? await preferenceGrantedConsents(ctx, account, purpose) : [] });
    }
    const matchingChanged = purposes.some(p => p.purpose === 'photo_matching' && p.changed);
    const processingChanged = purposes.some(p => p.purpose === 'photo_processing' && p.changed);
    return { purposes,
        recipientRequests: payload.receive_matches === false || matchingChanged ? await preferenceSharingRequests(ctx, account, 'recipient_id') : [],
        ownerRequests: processingChanged ? await preferenceSharingRequests(ctx, account, 'sender_id') : [] };
}
function preferenceFacts(plan: PreferencePlan): PreferenceRestrictionFact[] {
    const facts: PreferenceRestrictionFact[] = [
        ...plan.purposes.flatMap(p => p.withdrawn.map<PreferenceRestrictionFact>(consent => ({ kind: 'consent-withdrawn',
            scope: { account_id: consent.account_id, consent_id: consent.id, purpose: consent.purpose } }))),
        ...[...plan.recipientRequests, ...plan.ownerRequests].map<PreferenceRestrictionFact>(request => ({ kind: 'sharing-request-retired',
            scope: { sender_id: request.sender_id, recipient_id: request.recipient_id, request_id: request.id } })),
    ];
    return [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
}
async function preferences(request: Request, ctx: AppContext, actor: Actor): Promise<Response> {
    const payload = await jsonBody(request);
    if (typeof payload.policy_version !== 'string' || !payload.policy_version.trim() || payload.policy_version.length > 100)
        throw new ApiError(400, 'policy_version_required');
    const assertCurrentPolicy = () => {
        if (payload.policy_version !== currentPhotoPolicy(ctx))
            throw new ApiError(400, 'photo_policy_changed');
    };
    assertCurrentPolicy();
    for (const field of ['receive_matches', 'processing_consent', 'photo_matching_consent'])
        if (payload[field] != null && typeof payload[field] !== 'boolean')
            throw new ApiError(400, 'invalid_preferences');
    const intent = await prepareOperation('photo.preferences', payload, 'account');
    assertCurrentPolicy();
    return ok((await executeOperation(ctx, actor, intent, async restore => {
        (await assertMediaActor(ctx, actor));
        assertCurrentPolicy();
        const plan = await preferencePlan(ctx, actor.accountId, payload), facts = preferenceFacts(plan);
        // One saved preference action is atomic. Preserve the complete old
        // episodes; do not silently fit a prefix into a bounded journal plan.
        if (facts.length > 32) throw new ApiError(503, 'photo_preference_restriction_capacity');
        for (const fact of facts) await restore.restrict(fact.kind, fact.scope);
        if (stable(await preferencePlan(ctx, actor.accountId, payload)) !== stable(plan))
            throw new ApiError(409, 'photo_preference_authority_changed');
        assertCurrentPolicy();
        (await ctx.db.run('INSERT OR IGNORE INTO account_preferences(account_id,receive_matches,download_photos,updated_at) VALUES(?,0,0,?)', actor.accountId, ctx.now()));
        let matchingChanged = false, processingChanged = false;
        for (const [field, purpose] of [['processing_consent', 'photo_processing'], ['photo_matching_consent', 'photo_matching']] as const) {
            if (payload[field] == null)
                continue;
            const changed = await preferenceConsentChanged(ctx, actor.accountId, purpose, payload[field], payload.policy_version);
            const expected = plan.purposes.find(p => p.field === field)!;
            if (changed !== expected.changed || changed && stable(await preferenceGrantedConsents(ctx, actor.accountId, purpose)) !== stable(expected.withdrawn))
                throw new ApiError(409, 'photo_preference_authority_changed');
            // A routine save of unchanged granted policy keeps the same consent episode
            // and existing valid approvals. New policy/opt-out requires fresh matching.
            if (!changed)
                continue;
            if (purpose === 'photo_matching')
                matchingChanged = true;
            else
                processingChanged = true;
            assertCurrentPolicy();
            (await ctx.db.run(`UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose=? AND status='granted'`, ctx.now(), actor.accountId, purpose));
            if (payload[field]) {
                await assertAudienceCapability(ctx, actor.accountId, purpose);
                assertCurrentPolicy();
                const id = crypto.randomUUID();
                (await ctx.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,?,?,'granted',?)`, id, actor.accountId, purpose, payload.policy_version, ctx.now()));
                if (purpose === 'photo_matching')
                    (await ctx.db.run('UPDATE face_profiles SET consent_id=? WHERE account_id=? AND status=\'active\'', id, actor.accountId));
            }
        }
        if (matchingChanged) {
            (await ctx.db.run('INSERT OR IGNORE INTO face_profile_states(account_id,version,matching_paused) VALUES(?,1,0)', actor.accountId));
            (await ctx.db.run('UPDATE face_profile_states SET version=version+1,matching_paused=? WHERE account_id=?', payload.photo_matching_consent ? 0 : 1, actor.accountId));
            (await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id IN(SELECT challenge_id FROM face_profile_operations WHERE account_id=? AND state='pending')", ctx.now(), actor.accountId));
            (await ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND state='pending'", actor.accountId));
        }
        if (payload.receive_matches != null)
            (await ctx.db.run('UPDATE account_preferences SET receive_matches=?,updated_at=? WHERE account_id=?', payload.receive_matches ? 1 : 0, ctx.now(), actor.accountId));
        if (payload.receive_matches === true && !(await hasConsent(ctx, actor.accountId, 'photo_matching')))
            throw new ApiError(403, 'matching_consent_required');
        if (payload.receive_matches === false || matchingChanged) {
            if (stable(await preferenceSharingRequests(ctx, actor.accountId, 'recipient_id')) !== stable(plan.recipientRequests))
                throw new ApiError(409, 'photo_preference_authority_changed');
            // Changing the consent episode never restores old matching proposals or access.
            (await ctx.db.run(`UPDATE candidates SET status='invalidated' WHERE recipient_id=?`, actor.accountId));
            (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=? WHERE recipient_id=? AND active=1', ctx.now(), actor.accountId));
            (await ctx.db.run(`UPDATE sharing_requests SET status='revoked',updated_at=? WHERE recipient_id=? AND status='accepted'`, ctx.now(), actor.accountId));
        }
        if (processingChanged) {
            if (stable(await preferenceSharingRequests(ctx, actor.accountId, 'sender_id')) !== stable(plan.ownerRequests))
                throw new ApiError(409, 'photo_preference_authority_changed');
            (await ctx.db.run(`UPDATE candidates SET status='invalidated' WHERE owner_id=?`, actor.accountId));
            (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=? WHERE owner_id=? AND active=1', ctx.now(), actor.accountId));
            (await ctx.db.run(`UPDATE sharing_requests SET status='revoked',updated_at=? WHERE sender_id=? AND status='accepted'`, ctx.now(), actor.accountId));
        }
        const pref = (await ctx.db.one<{
            receive_matches: number;
        }>('SELECT receive_matches FROM account_preferences WHERE account_id=?', actor.accountId));
        const result = { receive_matches: pref?.receive_matches === 1, processing_consent: (await hasConsent(ctx, actor.accountId, 'photo_processing')),
            photo_matching_consent: (await hasConsent(ctx, actor.accountId, 'photo_matching')), policy_version: payload.policy_version };
        assertCurrentPolicy();
        return result;
    })));
}
async function reserve(request: Request, ctx: AppContext, actor: Actor): Promise<Response> {
    const payload = await jsonBody(request);
    const source = mediaSource(payload.source);
    const size = positive(payload.byte_size, MAX_SOURCE_BYTES);
    const type = imageType(payload.content_type);
    const resumable = validateResumable(payload);
    const batch = payload.upload_batch_id == null ? null : uuid(payload.upload_batch_id);
    if (payload.title != null && (typeof payload.title !== 'string' || payload.title.length > 500))
        throw new ApiError(400, 'invalid_metadata');
    const captured = payload.captured_at == null ? null : Date.parse(payload.captured_at);
    if (captured != null && !Number.isFinite(captured))
        throw new ApiError(400, 'invalid_metadata');
    const intent = await prepareOperation('photo.upload.reserve', payload, source);
    return ok((await executeUploadReservationOperation(ctx, actor, intent, async (_restore, id, version) => {
        (await assertMediaActor(ctx, actor));
        if (!(await hasConsent(ctx, actor.accountId, 'photo_processing')))
            throw new ApiError(403, 'processing_consent_required');
        const objectKey = `source/${actor.accountId}/${id}/${version}`;
        (await ctx.db.run(`INSERT INTO assets(id,owner_id,source,batch_id,status,object_key,content_type,byte_size,version,title,captured_at,created_at)
      VALUES(?,?,?,?,'uploading',?,?,?,?,?,?,?)`, id, actor.accountId, source, batch, objectKey, type, size, version, payload.title ?? null, captured, ctx.now()));
        if (resumable)
            (await createUploadTransfer(ctx, id, payload.checksum_sha256));
        return { asset_id: id, source, upload_batch_id: batch, version, status: 'uploading', upload_url: `/uploads/${id}`,
            complete_url: `/uploads/${id}/complete`, maximum_bytes: MAX_SOURCE_BYTES,
            ...(resumable ? { ...(await uploadStatusFields(ctx, (await currentAsset(ctx, id))!)), chunk_url: `/uploads/${id}/chunks`, processing_creates_access: false } : {}) };
    })), 201);
}
async function sourceBytes(request: Request, ctx: AppContext, actor: Actor, id: string): Promise<Response> {
    const initial = (await ctx.db.transaction(async () => {
        const asset = (await sourceAsset(ctx, actor, id));
        if ((await uploadTransfer(ctx, id)))
            throw new ApiError(409, 'upload_chunk_required');
        if (asset.status !== 'uploading')
            throw new ApiError(409, 'upload_not_pending');
        if (request.headers.get('content-type') !== asset.content_type)
            throw new ApiError(415, 'image_required');
        return asset;
    }));
    if (!Number.isSafeInteger(initial.byte_size) || initial.byte_size < 1 || initial.byte_size > MAX_SOURCE_BYTES)
        throw new ApiError(413, 'image_too_large');
    const bytes = new Uint8Array(initial.byte_size);
    const reader = new UploadBodyReader(request, UPLOAD_BODY_SOURCE_TOTAL_MS);
    let size = 0;
    let writtenKey: string | null = null;
    try {
        for (;;) {
            const next = await reader.readInto(bytes, size, 'image_too_large');
            (await ctx.db.transaction(async () => {
                const current = (await sourceAsset(ctx, actor, id));
                if (current.version !== initial.version || current.status !== 'uploading')
                    throw new ApiError(409, 'source_changed');
            }));
            reader.guard();
            if (next.done)
                break;
            size += next.length;
        }
        if (size !== initial.byte_size)
            throw new ApiError(400, 'image_size_mismatch');
        if (!imageMagic(bytes, initial.content_type))
            throw new ApiError(415, 'image_invalid');
        const checksum = await digest(bytes);
        (await ctx.db.transaction(async () => (await sourceAsset(ctx, actor, id))));
        reader.guard();
        // Concurrent PUTs write separate private keys. Only the winning current
        // transaction can bind its bytes to the asset; a late writer cannot replace it.
        const uploadBytes = new Uint8Array(bytes).buffer;
        const options = { httpMetadata: { contentType: initial.content_type },
            customMetadata: { source_version: initial.version, source_checksum_sha256: checksum, asset_id: id } };
        reader.guard();
        const candidateKey = `${initial.object_key}/${crypto.randomUUID()}`;
        const write = (await beginMediaWrite(ctx, actor, 'QUARANTINE', candidateKey));
        writtenKey = candidateKey;
        try {
            reader.guard();
        }
        catch (error) {
            // No PUT has been invoked. Do not delete a key we did not write,
            // even if recording the known-undispatched outcome fails.
            writtenKey = null;
            await completeUndispatchedMediaWrite(ctx, write);
            throw error;
        }
        try {
            await ctx.env.QUARANTINE.put(candidateKey, uploadBytes, options);
        }
        finally {
            (await settleMediaWrite(ctx, write));
        }
        (await ctx.db.transaction(async () => {
            const current = (await sourceAsset(ctx, actor, id));
            if (current.version !== initial.version || current.status !== 'uploading')
                throw new ApiError(409, 'source_changed');
            (await ctx.db.run(`UPDATE assets SET status='uploaded',checksum_sha256=?,object_key=? WHERE id=? AND version=? AND status='uploading'`, checksum, writtenKey, id, initial.version));
            (await assertMediaActor(ctx, actor));
        }));
        writtenKey = null;
        return ok({ asset_id: id, version: initial.version, status: 'uploaded' });
    }
    finally {
        bytes.fill(0);
        reader.close();
        if (writtenKey)
            await ctx.env.QUARANTINE.delete(writtenKey).catch(() => { });
    }
}
async function profilesForCapture(ctx: AppContext, ownerId: string, model: string): Promise<CapturedProfile[]> {
    const profiles = (await ctx.db.all<CapturedProfile>(`SELECT fp.id profile_id,fp.account_id,fp.revision,fp.model_id,
    fp.template_key,fp.template_digest,fp.consent_id matching_consent_id FROM face_profiles fp
    JOIN accounts a ON a.id=fp.account_id AND a.disabled_at IS NULL AND a.identity_state='registered_face'
    JOIN account_preferences p ON p.account_id=fp.account_id AND p.receive_matches=1
    JOIN consents c ON c.id=fp.consent_id AND c.account_id=fp.account_id AND c.purpose='photo_matching'
      AND c.status='granted' AND c.policy_version=? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
    WHERE fp.status='active' AND NOT EXISTS(SELECT 1 FROM face_profile_states lifecycle WHERE lifecycle.account_id=fp.account_id AND lifecycle.matching_paused=1) AND fp.model_id=? AND fp.account_id<>?
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=fp.account_id)
        OR (b.blocker_id=fp.account_id AND b.blocked_id=?)) ORDER BY fp.account_id LIMIT 1001`, currentPhotoPolicy(ctx), ctx.now(), model, ownerId, ownerId, ownerId));
    if (profiles.length > 1000)
        throw new ApiError(409, 'matching_scope_too_large');
    const eligible: CapturedProfile[] = [];
    for (const profile of profiles) {
        const audience_context = await audienceContext(ctx, profile.account_id, 'photo_matching');
        if (audience_context) eligible.push({ ...profile, audience_context });
    }
    return eligible;
}
async function complete(request: Request, ctx: AppContext, actor: Actor, id: string): Promise<Response> {
    const payload = await jsonBody(request);
    if (!ctx.env.PHOTO_PROCESSOR || !ctx.env.PHOTO_MODEL_VERSION)
        throw new ApiError(503, 'photo_processor_unavailable');
    const initial = (await ctx.db.transaction(async () => (await sourceAsset(ctx, actor, id))));
    const head = await ctx.env.QUARANTINE.head(initial.object_key);
    const intent = await prepareOperation('photo.upload.complete', { ...payload, asset_id: id }, initial.source);
    const response = (await executeOperation(ctx, actor, intent, async () => {
        const asset = (await sourceAsset(ctx, actor, id));
        if (asset.version !== initial.version || asset.checksum_sha256 !== initial.checksum_sha256)
            throw new ApiError(409, 'source_changed');
        if (!head || head.size !== asset.byte_size || head.customMetadata?.source_checksum_sha256 !== asset.checksum_sha256
            || head.customMetadata?.source_version !== asset.version)
            throw new ApiError(409, 'source_unverified');
        if (asset.status === 'ready')
            return { asset_id: id, status: 'ready', version: asset.version };
        if (asset.status === 'processing') {
            const current = (await ctx.db.one<{
                id: string;
            }>(`SELECT id FROM processing_attempts WHERE asset_id=? AND status IN('queued','running') ORDER BY captured_at DESC LIMIT 1`, id));
            if (!current)
                throw new ApiError(409, 'processing_state_invalid');
            return { asset_id: id, attempt_id: current.id, status: 'processing', version: asset.version };
        }
        if (!['uploaded', 'failed'].includes(asset.status) || !asset.checksum_sha256)
            throw new ApiError(409, 'upload_incomplete');
        const model = ctx.env.PHOTO_MODEL_VERSION!;
        const profiles = (await profilesForCapture(ctx, actor.accountId, model));
        const attempt = crypto.randomUUID();
        (await ctx.db.run(`INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,
      owner_id,owner_session_id,owner_auth_epoch,source,profiles_json,processor_nonce,engine_identity) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`, attempt, id, asset.version, asset.checksum_sha256, model, ctx.now(), ctx.now() + 15 * 60000, actor.accountId, actor.sessionId, actor.authEpoch, asset.source, stable(profiles), crypto.randomUUID(), selectedGeneration(ctx.env)));
        (await ctx.db.run(`INSERT INTO photo_job_outbox(id,attempt_id,asset_id,status,created_at) VALUES(?,?,?,'pending',?)`, crypto.randomUUID(), attempt, id, ctx.now()));
        (await ctx.db.run(`UPDATE assets SET status='processing' WHERE id=?`, id));
        return { asset_id: id, attempt_id: attempt, status: 'processing', version: asset.version };
    }));
    // Persisted outbox survives dispatch ambiguity; alarm retries the same attempt.
    await flushPhotoOutbox(ctx);
    (await ctx.db.transaction(async () => (await assertMediaActor(ctx, actor))));
    return ok(response, response.status === 'processing' ? 202 : 200);
}
export async function flushPhotoOutbox(ctx: AppContext): Promise<void> {
    const jobs = (await ctx.db.all<{
        id: string;
        attempt_id: string;
    }>(`SELECT id,attempt_id FROM photo_job_outbox WHERE status='pending' ORDER BY created_at,id LIMIT 20`));
    for (const job of jobs) {
        await ctx.env.PHOTO_JOBS.send({ category: 'photo', payload: { attempt_id: job.attempt_id } });
        (await ctx.db.transaction(async () => (await ctx.db.run(`UPDATE photo_job_outbox SET status='dispatched',dispatched_at=? WHERE id=? AND status='pending'`, ctx.now(), job.id))));
    }
}
async function attemptActor(ctx: AppContext, attempt: Attempt): Promise<Actor> {
    const session = (await ctx.db.one<any>(`SELECT s.*,a.roles_json FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.id=? AND s.account_id=? AND s.revoked_at IS NULL AND a.disabled_at IS NULL`, attempt.owner_session_id, attempt.owner_id));
    if (!session || session.auth_epoch !== attempt.owner_auth_epoch)
        throw new ApiError(401, 'session_revoked');
    return { accountId: attempt.owner_id, sessionId: session.id, roles: accountRoles(session.roles_json),
        expiresAt: session.expires_at, authEpoch: session.auth_epoch, authMethod: session.auth_method };
}
async function assertAttempt(ctx: AppContext, attempt: Attempt, actor: Actor, lease: string): Promise<Asset> {
    const asset = (await sourceAsset(ctx, actor, attempt.asset_id));
    const current = (await ctx.db.one<Attempt>('SELECT * FROM processing_attempts WHERE id=?', attempt.id));
    if (!current || current.status !== 'running' || current.lease_token !== lease || attempt.expires_at <= ctx.now()
        || asset.status !== 'processing' || asset.version !== attempt.source_version || asset.checksum_sha256 !== attempt.source_checksum_sha256
        || ctx.env.PHOTO_MODEL_VERSION !== attempt.model_version)
        throw new ApiError(409, 'processing_origin_changed');
    assertGeneration(current.engine_identity, ctx.env);
    assertGeneration(attempt.engine_identity, ctx.env);
    return asset;
}
/** Called exclusively by the Worker queue binding, never by a public URL. */
export async function processPhotoJob(message: unknown, ctx: AppContext): Promise<void> {
    const id = uuid((message as {
        attempt_id?: unknown;
    })?.attempt_id);
    const lease = crypto.randomUUID();
    let claimed: {
        attempt: Attempt;
        actor: Actor;
    } | null;
    try {
        claimed = (await ctx.db.transaction(async () => {
            const attempt = (await ctx.db.one<Attempt>('SELECT * FROM processing_attempts WHERE id=?', id));
            if (!attempt || ['completed', 'failed', 'cancelled'].includes(attempt.status))
                return null;
            const actor = (await attemptActor(ctx, attempt));
            (await sourceAsset(ctx, actor, attempt.asset_id));
            if (attempt.expires_at <= ctx.now())
                throw new ApiError(409, 'processing_attempt_expired');
            if (attempt.status === 'running' && (attempt.lease_until ?? 0) > ctx.now())
                throw new ApiError(503, 'processing_in_progress');
            if (!['queued', 'running'].includes(attempt.status))
                throw new ApiError(409, 'processing_state_invalid');
            assertGeneration(attempt.engine_identity, ctx.env);
            (await ctx.db.run(`UPDATE processing_attempts SET status='running',lease_token=?,lease_until=? WHERE id=?`, lease, ctx.now() + 5 * 60000, id));
            return { attempt, actor };
        }));
    }
    catch (error) {
        if (!(error instanceof ApiError) || error.code === 'processing_in_progress')
            throw error;
        // A revoked/expired authority is a terminal job failure, not an endlessly
        // retried proposal. This system-only write can revoke work, never create access.
        (await ctx.db.transaction(async () => {
            const attempt = (await ctx.db.one<Attempt>('SELECT * FROM processing_attempts WHERE id=?', id));
            if (attempt && ['queued', 'running'].includes(attempt.status)) {
                (await ctx.db.run(`UPDATE processing_attempts SET status='failed',error_code=?,lease_until=NULL WHERE id=?`, error.code, id));
                (await ctx.db.run(`UPDATE assets SET status='failed' WHERE id=? AND version=? AND status='processing'`, attempt.asset_id, attempt.source_version));
            }
        }));
        return;
    }
    if (!claimed)
        return;
    const { attempt, actor } = claimed;
    let publishedKey: string | null = null;
    let previewBytes: Uint8Array | undefined;
    try {
        if (!ctx.env.PHOTO_PROCESSOR)
            throw new ApiError(503, 'photo_processor_unavailable');
        const source = (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        const sourceHead = await ctx.env.QUARANTINE.head(source.object_key);
        (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        if (!sourceHead || sourceHead.size !== source.byte_size || sourceHead.customMetadata?.source_version !== attempt.source_version
            || sourceHead.customMetadata?.source_checksum_sha256 !== attempt.source_checksum_sha256)
            throw new ApiError(409, 'source_unverified');
        const capturedProfiles = canonicalProfiles(JSON.parse(attempt.profiles_json));
        const eligibleNow = canonicalProfiles(await profilesForCapture(ctx, actor.accountId, attempt.model_version));
        // Only subtract from the immutable captured set before dispatch; an old
        // queued attempt cannot acquire a newly consented/replaced profile.
        const admitted = new Map([...capturedProfiles].filter(([account, entry]) => eligibleNow.get(account)?.canonical === entry.canonical));
        const profiles = [...admitted.values()].map(entry => entry.profile);
        (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        const provider = await ctx.env.PHOTO_PROCESSOR.fetch(new Request('https://photo-processor.internal/process', { method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/json' }, body: stable({ attempt_id: attempt.id, nonce: attempt.processor_nonce,
                asset_id: attempt.asset_id, source_version: attempt.source_version, source_checksum_sha256: attempt.source_checksum_sha256,
                model_version: attempt.model_version, engine_identity: attempt.engine_identity, quarantine_key: source.object_key, profiles }) }), undefined, async (stage, bound) => {
            await ctx.db.transaction(async () => {
                await assertAttempt(ctx, attempt, actor, lease);
                if (bound) {
                    const entry = admitted.get(bound.account_id), captured = entry?.profile;
                    if (!captured || captured.profile_id !== bound.profile_id || captured.revision !== bound.revision || captured.model_id !== bound.model_id ||
                        await audienceContext(ctx, captured.account_id, 'photo_matching') !== captured.audience_context)
                        throw new ApiError(409, 'matching_profile_changed');
                    const actual = await ctx.db.one<CapturedProfile>(`SELECT fp.id profile_id,fp.account_id,fp.revision,fp.model_id,fp.template_key,fp.template_digest,fp.consent_id matching_consent_id FROM face_profiles fp
                      JOIN accounts a ON a.id=fp.account_id AND a.disabled_at IS NULL AND a.identity_state='registered_face'
                      JOIN account_preferences p ON p.account_id=fp.account_id AND p.receive_matches=1
                      JOIN consents c ON c.id=fp.consent_id AND c.account_id=fp.account_id AND c.purpose='photo_matching' AND c.status='granted' AND c.policy_version=? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
                      WHERE fp.account_id=? AND fp.status='active' AND NOT EXISTS(SELECT 1 FROM face_profile_states lifecycle WHERE lifecycle.account_id=fp.account_id AND lifecycle.matching_paused=1)
                      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=fp.account_id) OR (b.blocker_id=fp.account_id AND b.blocked_id=?))`,currentPhotoPolicy(ctx),ctx.now(),captured.account_id,actor.accountId,actor.accountId);
                    if (!actual || stable({...actual,audience_context:captured.audience_context}) !== entry!.canonical)
                        throw new ApiError(409, 'matching_profile_changed');
                }
                if (stage === 'before_dispatch') {
                    const current = canonicalProfiles(await profilesForCapture(ctx, actor.accountId, attempt.model_version));
                    if ([...admitted].some(([account, entry]) => current.get(account)?.canonical !== entry.canonical))
                        throw new ApiError(409, 'matching_profile_changed');
                }
                assertGeneration(attempt.engine_identity, ctx.env);
            });
        });
        (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        if (!provider.ok || provider.redirected) {
            const code = await processorFailureCode(provider, async () => {
                await ctx.db.transaction(async () => { await assertAttempt(ctx, attempt, actor, lease); });
            });
            (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
            if (code)
                throw new ApiError(409, code);
            throw new ApiError(503, 'photo_processing_unavailable');
        }
        const result = await jsonBody(provider as unknown as Request, 6 * 1024 * 1024);
        (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        if (result.attempt_id !== attempt.id || result.nonce !== attempt.processor_nonce || result.asset_id !== attempt.asset_id
            || result.source_version !== attempt.source_version || result.source_checksum_sha256 !== attempt.source_checksum_sha256
            || result.model_version !== attempt.model_version || result.engine_identity !== attempt.engine_identity)
            throw new ApiError(409, 'processor_origin_unverified');
        const image = result.preview;
        if (!image || typeof image.bytes_base64 !== 'string' || image.bytes_base64.length > Math.ceil(MAX_PREVIEW_BYTES * 4 / 3) + 4)
            throw new ApiError(502, 'processor_preview_invalid');
        const contentType = imageType(image.content_type);
        const width = positive(image.width, 100000), height = positive(image.height, 100000);
        try {
            previewBytes = Uint8Array.from(atob(image.bytes_base64), char => char.charCodeAt(0));
        }
        catch {
            throw new ApiError(502, 'processor_preview_invalid');
        }
        if (!previewBytes.length || previewBytes.length > MAX_PREVIEW_BYTES || !imageMagic(previewBytes, contentType))
            throw new ApiError(502, 'processor_preview_invalid');
        if (!Array.isArray(result.matches) || result.matches.length > 1000)
            throw new ApiError(502, 'processor_matches_invalid');
        const matches = result.matches.map((match: any) => {
            const recipient = uuid(match.recipient_id);
            const profile = admitted.get(recipient)?.profile;
            if (!profile || match.profile_id !== profile.profile_id || match.profile_version !== profile.revision
                || match.model_version !== profile.model_id)
                throw new ApiError(409, 'processor_origin_unverified');
            return profile;
        }) as CapturedProfile[];
        if (new Set(matches.map(profile => profile.account_id)).size !== matches.length)
            throw new ApiError(502, 'processor_matches_invalid');
        const previewHash = await digest(previewBytes);
        (await ctx.db.transaction(async () => (await assertAttempt(ctx, attempt, actor, lease))));
        const rendition = crypto.randomUUID(), version = crypto.randomUUID();
        publishedKey = `preview/${actor.accountId}/${attempt.asset_id}/${attempt.id}/${lease}`;
        // A stale lease can only write its own private object, never overwrite the winning rendition.
        const write = (await beginMediaWrite(ctx, actor, 'PHOTOS', publishedKey));
        try {
            await ctx.env.PHOTOS.put(publishedKey, new Uint8Array(previewBytes).buffer, { httpMetadata: { contentType }, customMetadata: {
                    source_checksum_sha256: attempt.source_checksum_sha256, source_version: attempt.source_version,
                    rendition_version: version, checksum_sha256: previewHash, asset_id: attempt.asset_id
                } });
        }
        finally {
            (await settleMediaWrite(ctx, write));
        }
        const finalSource = await ctx.env.QUARANTINE.head(source.object_key);
        (await ctx.db.transaction(async () => {
            (await assertAttempt(ctx, attempt, actor, lease));
            if (!finalSource || finalSource.etag !== sourceHead.etag || finalSource.customMetadata?.source_checksum_sha256 !== attempt.source_checksum_sha256)
                throw new ApiError(409, 'source_changed');
            const currentProfiles = canonicalProfiles(await profilesForCapture(ctx, actor.accountId, attempt.model_version));
            for (const profile of matches) {
                if (currentProfiles.get(profile.account_id)?.canonical !== admitted.get(profile.account_id)?.canonical)
                    throw new ApiError(409, 'matching_profile_changed');
            }
            (await ctx.db.run(`UPDATE renditions SET status='retired' WHERE asset_id=? AND status='ready'`, attempt.asset_id));
            (await ctx.db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,
        source_version,version,width,height,verified_at,status,model_version,kind,orientation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,'preview',1)`, rendition, attempt.asset_id, publishedKey, contentType, previewBytes!.byteLength, previewHash, attempt.source_checksum_sha256, attempt.source_version, version, width, height, ctx.now(), attempt.model_version));
            (await ctx.db.run(`UPDATE candidates SET status='invalidated' WHERE asset_id=?`, attempt.asset_id));
            for (const profile of matches) {
                const origin = crypto.randomUUID();
                const candidate = crypto.randomUUID();
                (await ctx.db.run(`INSERT INTO match_origins(id,asset_id,recipient_id,profile_id,profile_version,model_version,source_version,
          source_checksum_sha256,attempt_id,captured_at,expires_at,matching_consent_id,profile_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, origin, attempt.asset_id, profile.account_id, profile.profile_id, profile.revision, profile.model_id, attempt.source_version, attempt.source_checksum_sha256, attempt.id, attempt.captured_at, attempt.captured_at + 8 * 24 * 60 * 60000, profile.matching_consent_id, profile.template_digest));
                (await ctx.db.run(`INSERT INTO candidates(id,asset_id,owner_id,recipient_id,origin_id,status,version,created_at) VALUES(?,?,?,?,?,'eligible',?,?)
          ON CONFLICT(asset_id,owner_id,recipient_id) DO UPDATE SET origin_id=excluded.origin_id,status='eligible',version=excluded.version,created_at=excluded.created_at`, candidate, attempt.asset_id, actor.accountId, profile.account_id, origin, crypto.randomUUID(), ctx.now()));
            }
            const matchedTuples = matches.map(({ account_id, profile_id, revision, model_id }) => ({ account_id, profile_id, revision, model_id }));
            (await ctx.db.run(`UPDATE processing_attempts SET status='completed',completed_at=?,rendition_key=?,matches_json=?,lease_until=NULL WHERE id=? AND lease_token=?`, ctx.now(), publishedKey, stable(matchedTuples), attempt.id, lease));
            // Width/height above describe normalized protected rendition pixels. Original
            // source dimensions remain unknown unless a qualified parser supplies them.
            (await ctx.db.run(`UPDATE assets SET status='ready' WHERE id=? AND version=?`, attempt.asset_id, attempt.source_version));
            (await assertMediaActor(ctx, actor));
            assertGeneration(attempt.engine_identity, ctx.env);
        }));
        publishedKey = null;
    }
    catch (error) {
        if (publishedKey)
            await ctx.env.PHOTOS.delete(publishedKey).catch(() => { });
        (await ctx.db.transaction(async () => {
            const current = (await ctx.db.one<{
                status: string;
                lease_token: string;
            }>('SELECT status,lease_token FROM processing_attempts WHERE id=?', attempt.id));
            if (current?.status === 'running' && current.lease_token === lease) {
                (await ctx.db.run(`UPDATE processing_attempts SET status='failed',error_code=?,lease_until=NULL WHERE id=?`, error instanceof ApiError ? error.code : 'processing_failed', attempt.id));
                (await ctx.db.run(`UPDATE assets SET status='failed' WHERE id=? AND version=? AND status='processing'`, attempt.asset_id, attempt.source_version));
            }
        }));
        throw error;
    }
    finally {
        previewBytes?.fill(0);
    }
}
export async function handleProcessing(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === '/me/photo-preferences' && request.method === 'GET') {
        const actor = await ctx.authenticate(request);
        return ok((await ctx.db.transaction(async () => {
            (await assertMediaActor(ctx, actor));
            const receive = (await ctx.db.one<{
                receive_matches: number;
            }>('SELECT receive_matches FROM account_preferences WHERE account_id=?', actor.accountId))?.receive_matches === 1;
            const matching = (await hasConsent(ctx, actor.accountId, 'photo_matching'));
            const processing = (await hasConsent(ctx, actor.accountId, 'photo_processing'));
            return { policy_version: ctx.env.PHOTO_CONSENT_POLICY_VERSION ?? ctx.env.PHOTO_MODEL_VERSION,
                receive_matches: receive, matching_enabled: matching, processing_enabled: processing,
                photo_matching_consent: matching, processing_consent: processing };
        })));
    }
    if (url.pathname === '/me/photo-preferences' && request.method === 'POST')
        return (await preferences(request, ctx, await ctx.authenticate(request)));
    if (['/uploads/session', '/community/upload-session'].includes(url.pathname) && request.method === 'POST')
        return (await reserve(request, ctx, await ctx.authenticate(request)));
    const route = /^\/uploads\/([0-9a-f-]+)(?:\/(complete|status|chunks|cancel))?$/i.exec(url.pathname);
    if (!route)
        return null;
    const id = uuid(route[1]);
    const actor = await ctx.authenticate(request);
    if (request.method === 'PUT' && route[2] === 'chunks')
        return (await uploadChunk(request, ctx, actor, id));
    if (request.method === 'POST' && route[2] === 'cancel')
        return (await cancelUpload(request, ctx, actor, id));
    if (request.method === 'PUT' && !route[2])
        return (await sourceBytes(request, ctx, actor, id));
    if (request.method === 'POST' && route[2] === 'complete')
        return (await complete(request, ctx, actor, id));
    if (request.method === 'GET' && route[2] === 'status') {
        const state = (await ctx.db.transaction(async () => { const asset = (await uploadStatusAsset(ctx, actor, id)); (await uploadStatusFields(ctx, asset)); return (await uploadTransfer(ctx, asset.id)); }));
        if (state?.state === 'uploading' && state.bytes_received > 0 && (await ctx.db.transaction(async () => (await hasConsent(ctx, actor.accountId, 'photo_processing')))))
            await assembleUpload(ctx, actor, id);
        return ok((await ctx.db.transaction(async () => {
            const asset = (await uploadStatusAsset(ctx, actor, id));
            const details = (await uploadStatusFields(ctx, asset)), current = (await currentAsset(ctx, id))!;
            const attempt = (await ctx.db.one<{
                id: string;
                status: string;
                error_code: string | null;
            }>('SELECT id,status,error_code FROM processing_attempts WHERE asset_id=? ORDER BY captured_at DESC,id LIMIT 1', id));
            (await assertMediaActor(ctx, actor));
            return { asset_id: id, version: asset.version, status: current.status, attempt_id: attempt?.id ?? null, ...details,
                error_code: (await uploadTransfer(ctx, id))?.error_code ?? attempt?.error_code ?? null, candidates_ready: current.status === 'ready', processing_creates_access: false };
        })));
    }
    return null;
}
