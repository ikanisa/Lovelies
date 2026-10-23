import { ApiError, digest, jsonBody, ok, record, stable, uuid, type Actor, type AppContext } from './types.ts';
import { accountRoles, assertEnrollmentActor, authenticate, base64url, decodeBase64url, insertPreparedSession, opaque, prepareSession, type AccountRow } from './auth.ts';
import { beginFaceChallengeMediaWrite, settleMediaWrite } from './operations.ts';
import { lifecycleOperation, lifecycleAuthority, commitLifecycle } from './face-profile.ts';
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const CHALLENGE_MS = 120000;
const PROVIDER_MS = 60000;
const PROTOCOL = 'lovelies-face-auth-v1';
const DEVICE_PROTOCOL = 'lovelies-face-device-v1';
const VERDICT_PROTOCOL = 'lovelies-face-auth-verdict-v1';
const ENROLLMENT_PROTOCOL = 'lovelies-face-enrollment-v1';
const ENROLLMENT_DEVICE_PROTOCOL = 'lovelies-face-enrollment-device-v1';
const ENROLLMENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_PROTOCOL = 'lovelies-account-recovery-v1';
const RECOVERY_DEVICE_PROTOCOL = 'lovelies-account-recovery-device-v1';
const RECOVERY_KEY_MS = 365 * 24 * 60 * 60 * 1000;
const RECOVERY_RECEIPT_MS = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
// An expired persisted verifier state after an API isolate restart cannot commit. A
// verifier still running in this instance must settle before its successor.
const recoveryVerifiers = new WeakMap<object, Set<string>>();
export function activeFaceVerifiers(ctx: AppContext): Set<string> {
    let active = recoveryVerifiers.get(ctx.db);
    if (!active) {
        active = new Set();
        recoveryVerifiers.set(ctx.db, active);
    }
    return active;
}
export type Profile = {
    account_id: string;
    id: string;
    revision: string;
    model_id: string;
    template_key: string;
    template_digest: string;
    status: string;
    auth_enabled: number;
    auth_epoch: number;
    consent_id: string | null;
    auth_consent_id: string | null;
};
export type Device = {
    id: string;
    account_id: string;
    public_jwk: string;
    revision: string;
    status: string;
    face_handle: string | null;
};
export type Challenge = {
    id: string;
    account_id: string;
    device_id: string;
    purpose: 'registration' | 'login' | 'replacement';
    nonce: string;
    profile_revision: string | null;
    profile_id: string | null;
    model_id: string | null;
    profile_auth_epoch: number | null;
    reference_digest: string | null;
    policy_version: string;
    expires_at: number;
    status: string;
    attempts: number;
    created_at: number;
    session_id: string | null;
    auth_epoch: number;
    consent_id: string;
    used_at: number | null;
    device_revision: string;
    required_captures: 1 | 3;
};
type Capture = {
    challenge_id: string;
    capture_index: number;
    object_key: string;
    sha256: string;
    mime: string;
    byte_size: number;
    created_at: number;
};
type CaptureManifest = {
    index: number;
    sha256: string;
    mime: string;
    byte_size: number;
};
type Enrollment = {
    account_id: string;
    enrollment_key: string;
    device_id: string;
    device_revision: string;
    public_key_digest: string;
    handle_hash: string;
    start_hash: string;
    consent_id: string;
    policy_version: string;
    auth_epoch: number;
    challenge_id: string;
    generation: number;
    last_resume_key: string | null;
    previous_challenge_id: string | null;
    previous_generation: number | null;
    created_at: number;
    expires_at: number;
    revoked_at: number | null;
    completed_profile_id: string | null;
    completed_profile_revision: string | null;
    completed_model_id: string | null;
    completed_reference_digest: string | null;
    completed_auth_epoch: number | null;
    completed_profile_epoch: number | null;
};
type RecoveryKey = {
    id: string;
    account_id: string;
    token_hash: string;
    operation_key: string;
    profile_id: string;
    profile_revision: string;
    model_id: string;
    reference_digest: string;
    auth_epoch: number;
    profile_epoch: number;
    consent_id: string;
    policy_version: string;
    created_at: number;
    expires_at: number;
    revoked_at: number | null;
    consumed_at: number | null;
};
type RecoveryIntent = {
    account_id: string;
    recovery_request_id: string;
    key_id: string;
    device_id: string;
    device_revision: string;
    public_key_digest: string;
    public_jwk: string;
    handle_hash: string;
    start_hash: string;
    challenge_id: string;
    generation: number;
    last_resume_key: string | null;
    previous_challenge_id: string | null;
    previous_generation: number | null;
    created_at: number;
    expires_at: number;
    completed_at: number | null;
    completed_auth_epoch: number | null;
};
export function policy(ctx: AppContext): string {
    const value = ctx.env.FACE_AUTH_POLICY_VERSION;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value))
        throw new ApiError(503, 'face_authentication_unavailable');
    return value;
}
function verifierAvailable(ctx: AppContext): void {
    policy(ctx);
    if (!ctx.env.FACE_AUTH_VERIFIER)
        throw new ApiError(503, 'face_authentication_unavailable');
}
const hash = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        throw new ApiError(400, 'invalid_capture_digest');
    return value;
};
function boundedText(value: unknown, maximum = 128): string {
    if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))
        throw new ApiError(400, 'invalid_input');
    return value;
}
async function publicKey(value: unknown): Promise<JsonWebKey> {
    const key = record(value);
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.d != null ||
        Object.keys(key).some(name => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(name)) ||
        (key.ext != null && key.ext !== true) ||
        (key.key_ops != null && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify')))
        throw new ApiError(400, 'invalid_device_key');
    let x: Uint8Array, y: Uint8Array;
    try {
        x = decodeBase64url(key.x, 32);
        y = decodeBase64url(key.y, 32);
    }
    catch {
        throw new ApiError(400, 'invalid_device_key');
    }
    if (x.length !== 32 || y.length !== 32)
        throw new ApiError(400, 'invalid_device_key');
    const normalized: JsonWebKey = { kty: 'EC', crv: 'P-256', x: base64url(x), y: base64url(y), ext: true, key_ops: ['verify'] };
    try {
        await crypto.subtle.importKey('jwk', normalized, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    catch {
        throw new ApiError(400, 'invalid_device_key');
    }
    return normalized;
}
export async function getChallenge(id: string, ctx: AppContext): Promise<Challenge> {
    const value = (await ctx.db.one<Challenge>('SELECT * FROM auth_challenges WHERE id=?', id));
    if (!value)
        throw new ApiError(404, 'challenge_unavailable');
    return value;
}
async function assertNoEnrollmentDeletion(accountId: string, ctx: AppContext): Promise<void> {
    if ((await ctx.db.one(`SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete'
    AND status IN('pending_approval','approved','queued','processing','failed')
    AND (expires_at>? OR metadata_erased_at IS NOT NULL) LIMIT 1`, accountId, ctx.now())))
        throw new ApiError(409, 'enrollment_deletion_pending');
}
async function assertChallenge(challenge: Challenge, ctx: AppContext, expectedStatus: 'pending' | 'verifying' = 'pending'): Promise<void> {
    const current = (await getChallenge(challenge.id, ctx)), now = ctx.now();
    if (current.used_at !== null || current.status !== expectedStatus || current.expires_at <= now ||
        (expectedStatus === 'pending' ? current.attempts >= 3 : current.attempts > 3) || current.nonce !== challenge.nonce || current.auth_epoch !== challenge.auth_epoch ||
        current.policy_version !== policy(ctx))
        throw new ApiError(409, 'challenge_unavailable');
    const account = (await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', current.account_id));
    const recovery = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE challenge_id=?', current.id));
    const lifecycle = (await lifecycleOperation(current.id, ctx));
    const device = (await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=? AND account_id=?', current.device_id, current.account_id));
    const consent = (await ctx.db.one<{
        id: string;
    }>(`SELECT id FROM consents WHERE id=? AND account_id=?
    AND purpose='face_authentication' AND status='granted' AND revoked_at IS NULL
    AND policy_version=? AND (expires_at IS NULL OR expires_at>?)`, current.consent_id, current.account_id, current.policy_version, now));
    if (!account || account.disabled_at !== null || account.auth_epoch !== current.auth_epoch || !device ||
        device.revision !== current.device_revision || !consent ||
        (lifecycle ? device.status !== 'active' : current.purpose === 'registration' || recovery ? device.status !== 'pending' : device.status !== 'active'))
        throw new ApiError(401, 'challenge_account_changed');
    const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', current.account_id));
    if (current.profile_id === null) {
        if (profile || current.purpose !== 'registration' || current.required_captures !== 3)
            throw new ApiError(409, 'registered_reference_changed');
    }
    else if (!profile || profile.id !== current.profile_id || profile.revision !== current.profile_revision ||
        profile.model_id !== current.model_id || profile.auth_epoch !== current.profile_auth_epoch ||
        profile.template_digest !== current.reference_digest || profile.status !== 'active' ||
        (current.purpose === 'login' && (profile.auth_enabled !== 1 || profile.auth_consent_id !== current.consent_id)))
        throw new ApiError(409, 'registered_reference_changed');
    if (lifecycle) {
        (await lifecycleAuthority(lifecycle, ctx));
        return;
    }
    if (current.purpose === 'registration') {
        (await assertNoEnrollmentDeletion(current.account_id, ctx));
        const intent = (await ctx.db.one<Enrollment>('SELECT * FROM face_enrollment_intents WHERE challenge_id=?', current.id));
        if (intent)
            (await enrollmentAuthority(intent, ctx));
        const session = (await ctx.db.one<{
            expires_at: number;
            auth_method: Actor['authMethod'];
        }>('SELECT expires_at,auth_method FROM sessions WHERE id=? AND account_id=?', current.session_id, current.account_id));
        if (!session)
            throw new ApiError(401, 'session_invalid');
        (await assertEnrollmentActor({ accountId: account.id, sessionId: current.session_id!, roles: accountRoles(account.roles_json),
            expiresAt: session.expires_at, authEpoch: current.auth_epoch, authMethod: session.auth_method }, ctx));
    }
    else {
        if (account.identity_state !== 'registered_face')
            throw new ApiError(401, 'registered_face_required');
        if (recovery)
            (await recoveryAuthority(recovery, ctx));
    }
}
export function challengeResponse(challenge: Challenge): Record<string, unknown> {
    return { protocol: PROTOCOL, challenge_id: challenge.id, account_id: challenge.account_id,
        device_id: challenge.device_id, device_revision: challenge.device_revision, nonce: challenge.nonce,
        purpose: challenge.purpose, profile_id: challenge.profile_id, profile_revision: challenge.profile_revision,
        model_id: challenge.model_id, policy_version: challenge.policy_version,
        required_captures: challenge.required_captures,
        poses: challenge.required_captures === 3 ? ['front', 'left', 'right'] : ['front'],
        expires_at: new Date(challenge.expires_at).toISOString(), maximum_capture_bytes: MAX_CAPTURE_BYTES };
}
function deviceEnvelope(challenge: Challenge): Record<string, unknown> {
    return { protocol: DEVICE_PROTOCOL, challenge_id: challenge.id, nonce: challenge.nonce,
        purpose: challenge.purpose, account_id: challenge.account_id, device_id: challenge.device_id,
        device_revision: challenge.device_revision, profile_id: challenge.profile_id,
        profile_revision: challenge.profile_revision, policy_version: challenge.policy_version };
}
export async function captures(challenge: Challenge, ctx: AppContext): Promise<Capture[]> {
    return (await ctx.db.all<Capture>('SELECT * FROM auth_capture_proofs WHERE challenge_id=? ORDER BY capture_index', challenge.id));
}
export function manifest(rows: Capture[]): CaptureManifest[] {
    return rows.map(row => ({ index: row.capture_index, sha256: row.sha256, mime: row.mime, byte_size: row.byte_size }));
}
async function verifyDevice(challenge: Challenge, envelope: Record<string, unknown>, signatureValue: unknown, ctx: AppContext): Promise<void> {
    const device = (await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=? AND account_id=?', challenge.device_id, challenge.account_id));
    if (!device)
        throw new ApiError(401, 'device_proof_invalid');
    await verifyKey(JSON.parse(device.public_jwk), envelope, signatureValue);
}
export async function verifyKey(jwk: JsonWebKey, envelope: Record<string, unknown>, signatureValue: unknown): Promise<void> {
    let signature: Uint8Array;
    try {
        signature = decodeBase64url(signatureValue, 64);
    }
    catch {
        throw new ApiError(401, 'device_proof_invalid');
    }
    if (signature.length !== 64)
        throw new ApiError(401, 'device_proof_invalid');
    let verified = false;
    try {
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(signature).buffer, encoder.encode(stable(envelope)).buffer);
    }
    catch {
        throw new ApiError(401, 'device_proof_invalid');
    }
    finally {
        signature.fill(0);
    }
    if (!verified)
        throw new ApiError(401, 'device_proof_invalid');
}
async function registrationChallenge(request: Request, ctx: AppContext): Promise<Response> {
    const actor = await authenticate(request, ctx);
    verifierAvailable(ctx);
    const input = await jsonBody(request, 4096), consent = record(input.consent);
    const recoverable = input.enrollment_key !== undefined;
    if (Object.keys(input).some(key => !(recoverable
        ? ['device_public_jwk', 'consent', 'account_id', 'enrollment_key', 'face_handle', 'device_signature']
        : ['device_public_jwk', 'consent']).includes(key)) ||
        consent.purpose !== 'face_authentication' || consent.policy_version !== policy(ctx) || consent.granted !== true ||
        Object.keys(consent).some(key => !['purpose', 'policy_version', 'granted'].includes(key)))
        throw new ApiError(400, 'explicit_auth_consent_required');
    const jwk = await publicKey(input.device_public_jwk);
    (await assertEnrollmentActor(actor, ctx));
    (await assertNoEnrollmentDeletion(actor.accountId, ctx));
    if (recoverable)
        return (await startEnrollment(input, jwk, actor, ctx));
    const handle = opaque('lfh_'), handleHash = await digest(handle);
    (await assertEnrollmentActor(actor, ctx));
    const id = crypto.randomUUID(), deviceId = crypto.randomUUID(), consentId = crypto.randomUUID();
    const now = ctx.now(), revision = crypto.randomUUID(), nonce = opaque('lfn_');
    (await ctx.db.transaction(async () => {
        (await assertEnrollmentActor(actor, ctx));
        (await assertNoEnrollmentDeletion(actor.accountId, ctx));
        const pending = (await ctx.db.one<{
            n: number;
        }>(`SELECT COUNT(*) n FROM auth_challenges WHERE account_id=?
      AND status IN('pending','verifying') AND used_at IS NULL AND expires_at>?`, actor.accountId, now))?.n ?? 0;
        const recent = (await ctx.db.one<{
            n: number;
        }>('SELECT COUNT(*) n FROM auth_challenges WHERE account_id=? AND created_at>?', actor.accountId, now - 900000))?.n ?? 0;
        if (pending >= 3 || recent >= 10)
            throw new ApiError(429, 'enrollment_attempt_limit');
        const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', actor.accountId));
        if (profile && profile.status !== 'active')
            throw new ApiError(409, 'registered_reference_unavailable');
        (await ctx.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision)
      VALUES(?,?,'face_authentication',?,'granted',?,?)`, consentId, actor.accountId, policy(ctx), now, profile?.revision ?? null));
        (await ctx.db.run(`INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at,face_handle)
      VALUES(?,?,?,?,'pending',?,?)`, deviceId, actor.accountId, stable(jwk), revision, now, handleHash));
        (await ctx.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,profile_revision,profile_id,
      policy_version,expires_at,created_at,session_id,auth_epoch,consent_id,device_revision,model_id,
      profile_auth_epoch,reference_digest,required_captures) VALUES(?,?,?,'registration',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, actor.accountId, deviceId, nonce, profile?.revision ?? null, profile?.id ?? null, policy(ctx), now + CHALLENGE_MS, now, actor.sessionId, actor.authEpoch, consentId, revision, profile?.model_id ?? null, profile?.auth_epoch ?? null, profile?.template_digest ?? null, profile ? 1 : 3));
    }));
    return ok({ ...challengeResponse((await getChallenge(id, ctx))), face_handle: handle }, 201);
}
function faceHandle(value: unknown): string {
    if (typeof value !== 'string' || !/^lfh_[A-Za-z0-9_-]{43}$/.test(value))
        throw new ApiError(400, 'invalid_face_handle');
    return value;
}
async function enrollmentResponse(row: Enrollment, handle: string, ctx: AppContext): Promise<Record<string, unknown>> {
    return { ...challengeResponse((await getChallenge(row.challenge_id, ctx))), face_handle: handle,
        enrollment_key: row.enrollment_key, public_key_digest: row.public_key_digest,
        enrollment_generation: row.generation };
}
async function getEnrollment(account: string, key: string, ctx: AppContext): Promise<Enrollment | null> {
    return (await ctx.db.one<Enrollment>('SELECT * FROM face_enrollment_intents WHERE account_id=? AND enrollment_key=?', account, key));
}
async function enrollmentAuthority(row: Enrollment, ctx: AppContext, expectedPublicKey?: string): Promise<Enrollment> {
    const current = (await getEnrollment(row.account_id, row.enrollment_key, ctx)), now = ctx.now();
    if (!current || current.revoked_at !== null || current.expires_at <= now || current.policy_version !== policy(ctx) ||
        current.device_id !== row.device_id || current.device_revision !== row.device_revision ||
        current.public_key_digest !== row.public_key_digest || current.handle_hash !== row.handle_hash || current.start_hash !== row.start_hash)
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    const account = (await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', current.account_id));
    const device = (await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=? AND account_id=?', current.device_id, current.account_id));
    const consent = (await ctx.db.one<{
        profile_revision: string | null;
    }>(`SELECT profile_revision FROM consents WHERE id=? AND account_id=?
    AND purpose='face_authentication' AND status='granted' AND revoked_at IS NULL AND policy_version=?
    AND (expires_at IS NULL OR expires_at>?)`, current.consent_id, current.account_id, current.policy_version, now));
    const challenge = (await ctx.db.one<Challenge>('SELECT * FROM auth_challenges WHERE id=?', current.challenge_id));
    if (!account || account.disabled_at !== null || !device || device.revision !== current.device_revision ||
        device.face_handle !== current.handle_hash || (expectedPublicKey !== undefined && device.public_jwk !== expectedPublicKey) ||
        !consent || !challenge || challenge.account_id !== current.account_id || challenge.device_id !== current.device_id ||
        challenge.device_revision !== current.device_revision || challenge.consent_id !== current.consent_id || challenge.purpose !== 'registration')
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', current.account_id));
    if (current.completed_profile_id !== null) {
        if (device.status !== 'active' || account.identity_state !== 'registered_face' || account.auth_epoch !== current.completed_auth_epoch ||
            !profile || profile.id !== current.completed_profile_id || profile.revision !== current.completed_profile_revision ||
            profile.model_id !== current.completed_model_id || profile.auth_epoch !== current.completed_profile_epoch ||
            profile.template_digest !== current.completed_reference_digest ||
            profile.auth_consent_id !== current.consent_id || profile.status !== 'active' || profile.auth_enabled !== 1 ||
            consent.profile_revision !== profile.revision || challenge.status !== 'used' || challenge.used_at === null)
            throw new ApiError(404, 'enrollment_recovery_unavailable');
    }
    else if (device.status !== 'pending' || account.identity_state !== 'anonymous' || account.auth_epoch !== current.auth_epoch ||
        profile || challenge.profile_id !== null || challenge.auth_epoch !== current.auth_epoch || challenge.required_captures !== 3)
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    return current;
}
async function enrollmentLimit(account: string, ctx: AppContext): Promise<void> {
    const now = ctx.now();
    const pending = (await ctx.db.one<{
        n: number;
    }>(`SELECT COUNT(*) n FROM auth_challenges WHERE account_id=?
    AND status IN('pending','verifying') AND used_at IS NULL AND expires_at>?`, account, now))?.n ?? 0;
    const recent = (await ctx.db.one<{
        n: number;
    }>('SELECT COUNT(*) n FROM auth_challenges WHERE account_id=? AND created_at>?', account, now - 900000))?.n ?? 0;
    if (pending >= 3 || recent >= 10)
        throw new ApiError(429, 'enrollment_attempt_limit');
}
async function startEnrollment(input: Record<string, unknown>, jwk: JsonWebKey, actor: Actor, ctx: AppContext): Promise<Response> {
    const accountId = uuid(input.account_id), enrollmentKey = uuid(input.enrollment_key), handle = faceHandle(input.face_handle);
    if (accountId !== actor.accountId || actor.authMethod !== 'anonymous')
        throw new ApiError(403, 'enrollment_scope_invalid');
    const envelope = { protocol: ENROLLMENT_DEVICE_PROTOCOL, step: 'start', account_id: accountId,
        enrollment_key: enrollmentKey, face_handle: handle, policy_version: policy(ctx), device_public_jwk: jwk };
    await verifyKey(jwk, envelope, input.device_signature);
    const publicDigest = await digest(stable(jwk)), handleHash = await digest(handle);
    const startHash = await digest(stable({ account_id: accountId, enrollment_key: enrollmentKey,
        public_key_digest: publicDigest, handle_hash: handleHash, consent: input.consent }));
    return (await ctx.db.transaction(async () => {
        (await assertEnrollmentActor(actor, ctx));
        (await assertNoEnrollmentDeletion(accountId, ctx));
        const existing = (await getEnrollment(accountId, enrollmentKey, ctx));
        if (existing) {
            if (existing.start_hash !== startHash || existing.public_key_digest !== publicDigest || existing.handle_hash !== handleHash)
                throw new ApiError(409, 'enrollment_binding_conflict');
            return ok((await enrollmentResponse((await enrollmentAuthority(existing, ctx, stable(jwk))), handle, ctx)), 201);
        }
        if ((await ctx.db.one('SELECT id FROM auth_devices WHERE face_handle=?', handleHash)))
            throw new ApiError(409, 'enrollment_binding_conflict');
        if ((await ctx.db.one('SELECT id FROM face_profiles WHERE account_id=?', accountId)))
            throw new ApiError(409, 'registered_reference_changed');
        (await enrollmentLimit(accountId, ctx));
        const now = ctx.now(), deviceId = crypto.randomUUID(), deviceRevision = crypto.randomUUID(), consentId = crypto.randomUUID(), challengeId = crypto.randomUUID();
        (await ctx.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
      VALUES(?,?,'face_authentication',?,'granted',?)`, consentId, accountId, policy(ctx), now));
        (await ctx.db.run(`INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at,face_handle)
      VALUES(?,?,?,?,'pending',?,?)`, deviceId, accountId, stable(jwk), deviceRevision, now, handleHash));
        (await ctx.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,policy_version,expires_at,
      created_at,session_id,auth_epoch,consent_id,device_revision,required_captures)
      VALUES(?,?,?,'registration',?,?,?,?,?,?,?,?,3)`, challengeId, accountId, deviceId, opaque('lfn_'), policy(ctx), now + CHALLENGE_MS, now, actor.sessionId, actor.authEpoch, consentId, deviceRevision));
        (await ctx.db.run(`INSERT INTO face_enrollment_intents(account_id,enrollment_key,device_id,device_revision,public_key_digest,
      handle_hash,start_hash,consent_id,policy_version,auth_epoch,challenge_id,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, accountId, enrollmentKey, deviceId, deviceRevision, publicDigest, handleHash, startHash, consentId, policy(ctx), actor.authEpoch, challengeId, now, now + ENROLLMENT_MS));
        return ok((await enrollmentResponse((await getEnrollment(accountId, enrollmentKey, ctx))!, handle, ctx)), 201);
    }));
}
function recoveryDeadline(input: Record<string, unknown>, ctx: AppContext): void {
    uuid(input.request_nonce);
    if (!Number.isSafeInteger(input.request_expires_at) || (input.request_expires_at as number) <= ctx.now() ||
        (input.request_expires_at as number) > ctx.now() + 60000)
        throw new ApiError(400, 'enrollment_request_expired');
}
async function signedEnrollment(request: Request, step: 'status' | 'resume', ctx: AppContext): Promise<{
    row: Enrollment;
    input: Record<string, unknown>;
}> {
    const input = await jsonBody(request, 4096);
    const allowed = ['account_id', 'enrollment_key', 'face_handle', 'request_nonce', 'request_expires_at', 'device_signature',
        ...(step === 'resume' ? ['resume_key', 'expected_generation', 'expected_challenge_id'] : [])];
    if (Object.keys(input).some(key => !allowed.includes(key)))
        throw new ApiError(400, 'enrollment_input_invalid');
    const accountId = uuid(input.account_id), key = uuid(input.enrollment_key), handle = faceHandle(input.face_handle);
    recoveryDeadline(input, ctx);
    if (step === 'resume') {
        uuid(input.resume_key);
        uuid(input.expected_challenge_id);
        if (!Number.isSafeInteger(input.expected_generation) || (input.expected_generation as number) < 1)
            throw new ApiError(400, 'enrollment_input_invalid');
    }
    const handleHash = await digest(handle), row = (await getEnrollment(accountId, key, ctx));
    if (!row) {
        if (step === 'status' && request.headers.has('authorization')) {
            const actor = await authenticate(request, ctx);
            (await assertEnrollmentActor(actor, ctx));
            recoveryDeadline(input, ctx);
            if (actor.accountId === accountId && actor.authMethod === 'anonymous' &&
                !(await getEnrollment(accountId, key, ctx)) && !(await ctx.db.one('SELECT id FROM auth_devices WHERE face_handle=?', handleHash)))
                throw new ApiError(404, 'enrollment_not_found');
        }
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    }
    if (row.handle_hash !== handleHash)
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    (await enrollmentAuthority(row, ctx));
    const device = (await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=?', row.device_id))!;
    if (await digest(device.public_jwk) !== row.public_key_digest)
        throw new ApiError(404, 'enrollment_recovery_unavailable');
    const { device_signature: signature, ...fields } = input;
    await verifyKey(JSON.parse(device.public_jwk), { protocol: ENROLLMENT_DEVICE_PROTOCOL, step, ...fields }, signature);
    recoveryDeadline(input, ctx);
    return { row: (await enrollmentAuthority(row, ctx, device.public_jwk)), input };
}
async function unresolvedEnrollmentWriter(row: Enrollment, ctx: AppContext): Promise<boolean> {
    return !!(await ctx.db.one(`SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1`, row.account_id));
}
async function enrollmentState(row: Enrollment, ctx: AppContext): Promise<string> {
    if (row.completed_profile_id !== null)
        return 'registered';
    const challenge = (await getChallenge(row.challenge_id, ctx));
    if (challenge.status === 'verifying' && challenge.used_at === null)
        return 'verifying';
    if ((await unresolvedEnrollmentWriter(row, ctx)))
        return 'capture_pending';
    try {
        (await assertChallenge(challenge, ctx));
        return 'pending';
    }
    catch {
        return 'restart_required';
    }
}
async function recoverEnrollment(request: Request, ctx: AppContext): Promise<Response> {
    const { row, input } = await signedEnrollment(request, 'status', ctx), state = (await enrollmentState(row, ctx));
    const challenge = (await getChallenge(row.challenge_id, ctx)), usable = ['pending', 'capture_pending', 'verifying'].includes(state) && challenge.expires_at > ctx.now();
    return ok({ protocol: ENROLLMENT_PROTOCOL, account_id: row.account_id, enrollment_key: row.enrollment_key,
        device_id: row.device_id, device_revision: row.device_revision, public_key_digest: row.public_key_digest,
        policy_version: row.policy_version, enrollment_generation: row.generation, challenge_id: row.challenge_id, request_nonce: input.request_nonce,
        expires_at: new Date(row.expires_at).toISOString(), authenticated: false, state,
        challenge: usable ? challengeResponse(challenge) : null,
        captures: state === 'registered' ? [] : manifest((await captures(challenge, ctx))),
        profile: state === 'registered' ? { id: row.completed_profile_id, revision: row.completed_profile_revision, model_id: row.completed_model_id } : null });
}
async function resumeEnrollment(request: Request, ctx: AppContext): Promise<Response> {
    const actor = await authenticate(request, ctx);
    verifierAvailable(ctx);
    const { row, input } = await signedEnrollment(request, 'resume', ctx);
    return (await ctx.db.transaction(async () => {
        (await assertEnrollmentActor(actor, ctx));
        (await assertNoEnrollmentDeletion(row.account_id, ctx));
        recoveryDeadline(input, ctx);
        const current = (await enrollmentAuthority(row, ctx));
        if (actor.accountId !== current.account_id || actor.authMethod !== 'anonymous' || current.completed_profile_id !== null)
            throw new ApiError(403, 'enrollment_scope_invalid');
        if (current.last_resume_key === input.resume_key && current.previous_generation === input.expected_generation &&
            current.previous_challenge_id === input.expected_challenge_id && current.generation === (input.expected_generation as number) + 1)
            return ok((await enrollmentResponse(current, input.face_handle as string, ctx)), 201);
        if (current.generation !== input.expected_generation || current.challenge_id !== input.expected_challenge_id || current.last_resume_key === input.resume_key)
            throw new ApiError(409, 'enrollment_generation_conflict');
        const state = (await enrollmentState(current, ctx));
        if (state === 'verifying' || (await unresolvedEnrollmentWriter(current, ctx)))
            throw new ApiError(409, 'enrollment_in_flight');
        if (state === 'pending')
            return ok((await enrollmentResponse(current, input.face_handle as string, ctx)), 201);
        (await enrollmentLimit(current.account_id, ctx));
        const now = ctx.now(), id = crypto.randomUUID();
        (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE id=?`, now, current.challenge_id));
        (await ctx.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,policy_version,expires_at,
      created_at,session_id,auth_epoch,consent_id,device_revision,required_captures)
      VALUES(?,?,?,'registration',?,?,?,?,?,?,?,?,3)`, id, current.account_id, current.device_id, opaque('lfn_'), current.policy_version, now + CHALLENGE_MS, now, actor.sessionId, actor.authEpoch, current.consent_id, current.device_revision));
        (await ctx.db.run(`UPDATE face_enrollment_intents SET challenge_id=?,generation=generation+1,last_resume_key=?,
      previous_challenge_id=?,previous_generation=? WHERE account_id=? AND enrollment_key=?`, id, input.resume_key as string, current.challenge_id, current.generation, current.account_id, current.enrollment_key));
        return ok((await enrollmentResponse((await getEnrollment(current.account_id, current.enrollment_key, ctx))!, input.face_handle as string, ctx)), 201);
    }));
}
async function recoveryKeyAuthority(key: RecoveryKey, ctx: AppContext, completed?: RecoveryIntent, notYetStored = false): Promise<Profile> {
    const stored = (await ctx.db.one<RecoveryKey>('SELECT * FROM face_recovery_keys WHERE id=? AND account_id=?', key.id, key.account_id));
    if (!stored && !notYetStored)
        throw new ApiError(401, 'account_recovery_unavailable');
    if (stored)
        key = stored;
    const now = ctx.now(), account = (await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', key.account_id));
    const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', key.account_id));
    const consent = (await ctx.db.one<{
        id: string;
    }>(`SELECT id FROM consents WHERE id=? AND account_id=?
    AND purpose='face_authentication' AND status='granted' AND revoked_at IS NULL AND policy_version=?
    AND (expires_at IS NULL OR expires_at>?) AND (profile_revision IS NULL OR profile_revision=?)`, key.consent_id, key.account_id, key.policy_version, now, key.profile_revision));
    if (key.revoked_at !== null || key.expires_at <= now || key.policy_version !== policy(ctx) ||
        !account || account.disabled_at !== null || account.identity_state !== 'registered_face' ||
        account.auth_epoch !== (completed?.completed_auth_epoch ?? key.auth_epoch) ||
        !profile || profile.status !== 'active' || profile.auth_enabled !== 1 ||
        profile.id !== key.profile_id || profile.revision !== key.profile_revision ||
        profile.model_id !== key.model_id || profile.template_digest !== key.reference_digest ||
        profile.auth_epoch !== key.profile_epoch || profile.auth_consent_id !== key.consent_id || !consent ||
        (completed ? completed.key_id !== key.id || completed.completed_at === null ||
            completed.completed_at !== key.consumed_at : key.consumed_at !== null))
        throw new ApiError(401, 'account_recovery_unavailable');
    (await assertNoEnrollmentDeletion(key.account_id, ctx));
    return profile;
}
async function recoveryAuthority(intent: RecoveryIntent, ctx: AppContext): Promise<RecoveryKey> {
    const current = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', intent.account_id, intent.recovery_request_id));
    const key = current && (await ctx.db.one<RecoveryKey>('SELECT * FROM face_recovery_keys WHERE id=? AND account_id=?', current.key_id, current.account_id));
    const device = current && (await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=? AND account_id=?', current.device_id, current.account_id));
    if (!current || !key || current.expires_at <= ctx.now() || !device || current.key_id !== intent.key_id ||
        current.device_id !== intent.device_id || current.device_revision !== intent.device_revision ||
        current.challenge_id !== intent.challenge_id || current.generation !== intent.generation ||
        current.public_jwk !== intent.public_jwk || current.handle_hash !== intent.handle_hash ||
        device.public_jwk !== current.public_jwk || device.revision !== current.device_revision ||
        device.face_handle !== current.handle_hash || device.status !== (current.completed_at === null ? 'pending' : 'active'))
        throw new ApiError(401, 'account_recovery_unavailable');
    (await recoveryKeyAuthority(key, ctx, current.completed_at === null ? undefined : current));
    return key;
}
function recoveryKeyResponse(key: RecoveryKey): Record<string, unknown> {
    return { protocol: RECOVERY_PROTOCOL, state: 'ready', account_id: key.account_id,
        key_id: key.id, operation_key: key.operation_key, expires_at: new Date(key.expires_at).toISOString() };
}
function recoverySecret(value: unknown): string {
    if (typeof value !== 'string' || !/^lfr_[A-Za-z0-9_-]{43}$/.test(value))
        throw new ApiError(400, 'invalid_recovery_key');
    // Reject noncanonical base64 encodings; all 256 random bits must be retained.
    if (decodeBase64url(value.slice(4), 32).length !== 32)
        throw new ApiError(400, 'invalid_recovery_key');
    return value;
}
async function revokeRecoveryKeys(accountId: string, ctx: AppContext): Promise<void> {
    (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=? WHERE used_at IS NULL AND id IN(
    SELECT i.challenge_id FROM face_recovery_intents i JOIN face_recovery_keys k ON k.id=i.key_id
    WHERE k.account_id=? AND i.completed_at IS NULL)`, ctx.now(), accountId));
    (await ctx.db.run(`UPDATE auth_devices SET status='revoked',face_handle=NULL WHERE id IN(
    SELECT device_id FROM face_recovery_intents WHERE account_id=? AND completed_at IS NULL)`, accountId));
    (await ctx.db.run('UPDATE face_recovery_keys SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?', ctx.now(), accountId));
}
async function manageRecoveryKey(request: Request, ctx: AppContext): Promise<Response> {
    const actor = await authenticate(request, ctx);
    (await ctx.assertActor(actor));
    (await assertNoEnrollmentDeletion(actor.accountId, ctx));
    if (request.method === 'DELETE') {
        (await ctx.db.transaction(async () => { (await ctx.assertActor(actor)); (await assertNoEnrollmentDeletion(actor.accountId, ctx)); (await revokeRecoveryKeys(actor.accountId, ctx)); }));
        return ok({ protocol: RECOVERY_PROTOCOL, state: 'revoked', account_id: actor.accountId });
    }
    if (request.method === 'GET') {
        const key = (await ctx.db.one<RecoveryKey>(`SELECT * FROM face_recovery_keys WHERE account_id=? AND revoked_at IS NULL
      AND consumed_at IS NULL ORDER BY created_at DESC,id LIMIT 1`, actor.accountId));
        if (key) {
            try {
                (await recoveryKeyAuthority(key, ctx));
                return ok(recoveryKeyResponse(key));
            }
            catch (error) {
                if (!(error instanceof ApiError) || error.code !== 'account_recovery_unavailable')
                    throw error;
            }
        }
        return ok({ protocol: RECOVERY_PROTOCOL, state: 'unavailable', account_id: actor.accountId });
    }
    const input = await jsonBody(request, 1024);
    if (Object.keys(input).some(field => !['operation_key', 'recovery_key'].includes(field)))
        throw new ApiError(400, 'invalid_input');
    const operationKey = uuid(input.operation_key), tokenHash = await digest(recoverySecret(input.recovery_key));
    const key = (await ctx.db.transaction(async () => {
        (await ctx.assertActor(actor));
        (await assertNoEnrollmentDeletion(actor.accountId, ctx));
        const previous = (await ctx.db.one<RecoveryKey>('SELECT * FROM face_recovery_keys WHERE account_id=? AND operation_key=?', actor.accountId, operationKey));
        if (previous) {
            if (previous.token_hash !== tokenHash)
                throw new ApiError(409, 'account_recovery_binding_conflict');
            (await recoveryKeyAuthority(previous, ctx));
            return previous;
        }
        if ((await ctx.db.one('SELECT id FROM face_recovery_keys WHERE token_hash=?', tokenHash)))
            throw new ApiError(409, 'account_recovery_binding_conflict');
        const recent = (await ctx.db.one<{
            n: number;
        }>('SELECT count(*) n FROM face_recovery_keys WHERE account_id=? AND created_at>?', actor.accountId, ctx.now() - 900000))?.n ?? 0;
        if (recent >= 10)
            throw new ApiError(429, 'account_recovery_key_limit');
        const account = (await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', actor.accountId))!;
        const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', actor.accountId))!;
        const row: RecoveryKey = { id: crypto.randomUUID(), account_id: account.id, token_hash: tokenHash, operation_key: operationKey,
            profile_id: profile.id, profile_revision: profile.revision, model_id: profile.model_id, reference_digest: profile.template_digest,
            auth_epoch: account.auth_epoch, profile_epoch: profile.auth_epoch, consent_id: profile.auth_consent_id!, policy_version: policy(ctx),
            created_at: ctx.now(), expires_at: ctx.now() + RECOVERY_KEY_MS, revoked_at: null, consumed_at: null };
        (await recoveryKeyAuthority(row, ctx, undefined, true));
        (await revokeRecoveryKeys(actor.accountId, ctx));
        (await ctx.db.run(`INSERT INTO face_recovery_keys(id,account_id,token_hash,operation_key,profile_id,profile_revision,
      model_id,reference_digest,auth_epoch,profile_epoch,consent_id,policy_version,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.account_id, row.token_hash, row.operation_key, row.profile_id, row.profile_revision, row.model_id, row.reference_digest, row.auth_epoch, row.profile_epoch, row.consent_id, row.policy_version, row.created_at, row.expires_at));
        return row;
    }));
    return ok(recoveryKeyResponse(key), 201);
}
type SignedRecovery = {
    input: Record<string, unknown>;
    base: Record<string, unknown>;
    key: RecoveryKey;
    intent: RecoveryIntent | null;
    jwk: JsonWebKey;
    keyDigest: string;
    handleHash: string;
    startHash: string;
};
async function signedRecovery(request: Request, step: 'start' | 'status' | 'resume', ctx: AppContext): Promise<SignedRecovery> {
    const input = await jsonBody(request, 4096);
    const fields = ['account_id', 'recovery_key', 'recovery_request_id', 'face_handle', 'device_public_jwk', 'policy_version'];
    const extra = step === 'start' ? [] : ['request_nonce', 'request_expires_at', ...(step === 'resume'
            ? ['resume_key', 'expected_challenge_id', 'expected_generation'] : [])];
    if (Object.keys(input).some(field => ![...fields, ...extra, 'device_signature'].includes(field)))
        throw new ApiError(400, 'invalid_input');
    const accountId = uuid(input.account_id), requestId = uuid(input.recovery_request_id), rawKey = recoverySecret(input.recovery_key);
    if (typeof input.face_handle !== 'string' || !/^lfh_[A-Za-z0-9_-]{43}$/.test(input.face_handle))
        throw new ApiError(400, 'invalid_face_handle');
    if (input.policy_version !== policy(ctx))
        throw new ApiError(401, 'account_recovery_unavailable');
    if (step !== 'start') {
        uuid(input.request_nonce);
        recoveryDeadline(input, ctx);
    }
    if (step === 'resume') {
        uuid(input.resume_key);
        uuid(input.expected_challenge_id);
        if (!Number.isSafeInteger(input.expected_generation) || Number(input.expected_generation) < 1)
            throw new ApiError(400, 'invalid_input');
    }
    const jwk = await publicKey(input.device_public_jwk), canonicalKey = stable(jwk);
    const base = { account_id: accountId, recovery_key: rawKey, recovery_request_id: requestId,
        face_handle: input.face_handle, device_public_jwk: jwk, policy_version: input.policy_version };
    const tokenHash = await digest(rawKey), handleHash = await digest(input.face_handle);
    const keyDigest = await digest(canonicalKey), startHash = await digest(stable(base));
    let key = (await ctx.db.one<RecoveryKey>('SELECT * FROM face_recovery_keys WHERE account_id=? AND token_hash=?', accountId, tokenHash));
    let intent = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', accountId, requestId));
    if (!key)
        throw new ApiError(401, 'account_recovery_unavailable');
    if (intent && (intent.key_id !== key.id || intent.start_hash !== startHash || intent.public_key_digest !== keyDigest ||
        intent.public_jwk !== canonicalKey || intent.handle_hash !== handleHash))
        throw new ApiError(409, 'account_recovery_binding_conflict');
    if (intent)
        (await recoveryAuthority(intent, ctx));
    else
        (await recoveryKeyAuthority(key, ctx));
    const envelope = { protocol: RECOVERY_DEVICE_PROTOCOL, step, ...base,
        ...Object.fromEntries(extra.map(field => [field, input[field]])) };
    await verifyKey(jwk, envelope, input.device_signature);
    if (step !== 'start')
        recoveryDeadline(input, ctx);
    // Re-read after crypto: completion/revocation may have raced verification.
    key = (await ctx.db.one<RecoveryKey>('SELECT * FROM face_recovery_keys WHERE id=?', key.id));
    intent = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', accountId, requestId));
    if (!key)
        throw new ApiError(401, 'account_recovery_unavailable');
    if (intent) {
        if (intent.key_id !== key.id || intent.start_hash !== startHash || intent.public_jwk !== canonicalKey || intent.handle_hash !== handleHash)
            throw new ApiError(409, 'account_recovery_binding_conflict');
        (await recoveryAuthority(intent, ctx));
    }
    else
        (await recoveryKeyAuthority(key, ctx));
    return { input, base, key, intent, jwk, keyDigest, handleHash, startHash };
}
async function recoveryChallenge(intent: RecoveryIntent, ctx: AppContext): Promise<Record<string, unknown>> {
    return { ...challengeResponse((await getChallenge(intent.challenge_id, ctx))), recovery_request_id: intent.recovery_request_id,
        recovery_generation: intent.generation };
}
async function insertRecoveryChallenge(intent: RecoveryIntent, key: RecoveryKey, ctx: AppContext): Promise<void> {
    const now = ctx.now();
    const pending = (await ctx.db.one<{
        n: number;
    }>(`SELECT count(*) n FROM auth_challenges WHERE account_id=?
    AND status IN('pending','verifying') AND used_at IS NULL AND expires_at>?`, key.account_id, now))?.n ?? 0;
    const recent = (await ctx.db.one<{
        n: number;
    }>('SELECT count(*) n FROM auth_challenges WHERE account_id=? AND created_at>?', key.account_id, now - 900000))?.n ?? 0;
    if (pending >= 3 || recent >= 10)
        throw new ApiError(429, 'face_attempt_limit');
    (await ctx.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,profile_revision,profile_id,
    policy_version,expires_at,created_at,auth_epoch,consent_id,device_revision,model_id,profile_auth_epoch,
    reference_digest,required_captures) VALUES(?,?,?,'login',?,?,?,?,?,?,?,?,?,?,?,?,1)`, intent.challenge_id, key.account_id, intent.device_id, opaque('lfn_'), key.profile_revision, key.profile_id, key.policy_version, now + CHALLENGE_MS, now, key.auth_epoch, key.consent_id, intent.device_revision, key.model_id, key.profile_epoch, key.reference_digest));
}
async function startAccountRecovery(request: Request, ctx: AppContext): Promise<Response> {
    verifierAvailable(ctx);
    const signed = await signedRecovery(request, 'start', ctx);
    const intent = (await ctx.db.transaction(async () => {
        const prior = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', signed.key.account_id, String(signed.base.recovery_request_id)));
        if (prior) {
            (await recoveryAuthority(prior, ctx));
            if (prior.completed_at !== null)
                throw new ApiError(409, 'account_recovery_registered');
            const challenge = (await getChallenge(prior.challenge_id, ctx));
            if (challenge.status !== 'pending' || challenge.expires_at <= ctx.now())
                throw new ApiError(409, 'account_recovery_reconcile_required');
            (await assertChallenge(challenge, ctx));
            return prior;
        }
        (await recoveryKeyAuthority(signed.key, ctx));
        if ((await ctx.db.one('SELECT id FROM auth_devices WHERE face_handle=?', signed.handleHash)))
            throw new ApiError(409, 'account_recovery_binding_conflict');
        const row: RecoveryIntent = { account_id: signed.key.account_id, recovery_request_id: String(signed.base.recovery_request_id),
            key_id: signed.key.id, device_id: crypto.randomUUID(), device_revision: crypto.randomUUID(), public_key_digest: signed.keyDigest,
            public_jwk: stable(signed.jwk), handle_hash: signed.handleHash, start_hash: signed.startHash,
            challenge_id: crypto.randomUUID(), generation: 1, last_resume_key: null, previous_challenge_id: null,
            previous_generation: null, created_at: ctx.now(), expires_at: ctx.now() + RECOVERY_RECEIPT_MS,
            completed_at: null, completed_auth_epoch: null };
        (await ctx.db.run(`INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at,face_handle)
      VALUES(?,?,?,?,'pending',?,?)`, row.device_id, row.account_id, row.public_jwk, row.device_revision, row.created_at, row.handle_hash));
        (await insertRecoveryChallenge(row, signed.key, ctx));
        (await ctx.db.run(`INSERT INTO face_recovery_intents(account_id,recovery_request_id,key_id,device_id,device_revision,
      public_key_digest,public_jwk,handle_hash,start_hash,challenge_id,generation,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`, row.account_id, row.recovery_request_id, row.key_id, row.device_id, row.device_revision, row.public_key_digest, row.public_jwk, row.handle_hash, row.start_hash, row.challenge_id, row.created_at, row.expires_at));
        (await assertChallenge((await getChallenge(row.challenge_id, ctx)), ctx));
        return row;
    }));
    return ok((await recoveryChallenge(intent, ctx)), 201);
}
async function accountRecoveryStatus(request: Request, ctx: AppContext): Promise<Response> {
    const { input, base, key: signedKey } = await signedRecovery(request, 'status', ctx);
    const intent = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', String(base.account_id), String(base.recovery_request_id)));
    if (!intent) {
        (await recoveryKeyAuthority(signedKey, ctx));
        throw new ApiError(404, 'account_recovery_not_found');
    }
    const key = (await recoveryAuthority(intent, ctx)), challenge = (await getChallenge(intent.challenge_id, ctx));
    const writing = !!(await ctx.db.one(`SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1`, intent.account_id));
    const terminal = challenge.used_at !== null || challenge.expires_at <= ctx.now() || !['pending', 'verifying'].includes(challenge.status);
    const state = intent.completed_at !== null ? 'registered' : writing ? 'capture_pending' : challenge.status === 'verifying' &&
        (challenge.expires_at > ctx.now() || activeFaceVerifiers(ctx).has(challenge.id))
        ? 'verifying' : terminal ? 'restart_required' : 'pending';
    return ok({ protocol: RECOVERY_PROTOCOL, authenticated: false, state, account_id: intent.account_id,
        recovery_request_id: intent.recovery_request_id, device_id: intent.device_id, device_revision: intent.device_revision,
        public_key_digest: intent.public_key_digest, policy_version: key.policy_version, challenge_id: intent.challenge_id,
        generation: intent.generation, request_nonce: input.request_nonce, expires_at: new Date(intent.expires_at).toISOString(),
        challenge: state === 'pending' ? (await recoveryChallenge(intent, ctx)) : null,
        captures: state === 'registered' ? [] : manifest((await captures(challenge, ctx))),
        profile: { id: key.profile_id, revision: key.profile_revision, model_id: key.model_id } });
}
async function resumeAccountRecovery(request: Request, ctx: AppContext): Promise<Response> {
    verifierAvailable(ctx);
    const { input, base, key: signedKey } = await signedRecovery(request, 'resume', ctx);
    const next = (await ctx.db.transaction(async () => {
        recoveryDeadline(input, ctx);
        const intent = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', String(base.account_id), String(base.recovery_request_id)));
        if (!intent) {
            (await recoveryKeyAuthority(signedKey, ctx));
            throw new ApiError(404, 'account_recovery_not_found');
        }
        const key = (await recoveryAuthority(intent, ctx));
        if (intent.completed_at !== null)
            throw new ApiError(409, 'account_recovery_registered');
        if (intent.last_resume_key === input.resume_key && intent.previous_challenge_id === input.expected_challenge_id &&
            intent.previous_generation === input.expected_generation)
            return intent;
        if (intent.generation !== input.expected_generation || intent.challenge_id !== input.expected_challenge_id)
            throw new ApiError(409, 'account_recovery_predecessor_changed');
        const prior = (await getChallenge(intent.challenge_id, ctx));
        if ((prior.status === 'verifying' && (prior.expires_at > ctx.now() || activeFaceVerifiers(ctx).has(prior.id))) || (await ctx.db.one(`SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1`, intent.account_id)))
            throw new ApiError(409, 'account_recovery_in_flight');
        if (prior.status === 'pending' && prior.used_at === null && prior.expires_at > ctx.now())
            throw new ApiError(409, 'account_recovery_not_terminal');
        (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE id=?`, ctx.now(), prior.id));
        const successor: RecoveryIntent = { ...intent, challenge_id: crypto.randomUUID(), generation: intent.generation + 1,
            last_resume_key: String(input.resume_key), previous_challenge_id: intent.challenge_id, previous_generation: intent.generation };
        (await insertRecoveryChallenge(successor, key, ctx));
        (await ctx.db.run(`UPDATE face_recovery_intents SET challenge_id=?,generation=?,last_resume_key=?,previous_challenge_id=?,
      previous_generation=? WHERE account_id=? AND recovery_request_id=?`, successor.challenge_id, successor.generation, successor.last_resume_key, successor.previous_challenge_id, successor.previous_generation, intent.account_id, intent.recovery_request_id));
        (await assertChallenge((await getChallenge(successor.challenge_id, ctx)), ctx));
        return successor;
    }));
    return ok((await recoveryChallenge(next, ctx)), 201);
}
async function loginChallenge(request: Request, ctx: AppContext): Promise<Response> {
    verifierAvailable(ctx);
    const input = await jsonBody(request, 1024);
    if (typeof input.face_handle !== 'string' || !/^lfh_[A-Za-z0-9_-]{43}$/.test(input.face_handle) ||
        Object.keys(input).some(key => !['face_handle', 'device_id'].includes(key)))
        throw new ApiError(400, 'invalid_face_handle');
    const deviceId = uuid(input.device_id), handleHash = await digest(input.face_handle);
    const device = (await ctx.db.one<Device>(`SELECT * FROM auth_devices WHERE id=? AND face_handle=? AND status='active'`, deviceId, handleHash));
    if (!device)
        throw new ApiError(401, 'face_handle_unavailable');
    const id = crypto.randomUUID(), now = ctx.now();
    (await ctx.db.transaction(async () => {
        const account = (await ctx.db.one<AccountRow>(`SELECT * FROM accounts WHERE id=? AND disabled_at IS NULL AND identity_state='registered_face'`, device.account_id));
        const profile = (await ctx.db.one<Profile>(`SELECT * FROM face_profiles WHERE account_id=? AND status='active' AND auth_enabled=1`, device.account_id));
        const currentDevice = (await ctx.db.one<Device>(`SELECT * FROM auth_devices WHERE id=? AND face_handle=? AND status='active'`, deviceId, handleHash));
        if (!account || !profile || !currentDevice || currentDevice.revision !== device.revision || !profile.auth_consent_id)
            throw new ApiError(401, 'face_handle_unavailable');
        const pending = (await ctx.db.one<{
            n: number;
        }>(`SELECT COUNT(*) n FROM auth_challenges WHERE account_id=? AND status IN('pending','verifying') AND expires_at>?`, account.id, now))?.n ?? 0;
        const recent = (await ctx.db.one<{
            n: number;
        }>('SELECT COUNT(*) n FROM auth_challenges WHERE account_id=? AND created_at>?', account.id, now - 900000))?.n ?? 0;
        if (pending >= 3 || recent >= 10)
            throw new ApiError(429, 'face_attempt_limit');
        (await ctx.db.run(`INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,profile_revision,profile_id,
      policy_version,expires_at,created_at,auth_epoch,consent_id,device_revision,model_id,profile_auth_epoch,
      reference_digest,required_captures) VALUES(?,?,?,'login',?,?,?,?,?,?,?,?,?,?,?,?,1)`, id, account.id, device.id, opaque('lfn_'), profile.revision, profile.id, policy(ctx), now + CHALLENGE_MS, now, account.auth_epoch, profile.auth_consent_id, device.revision, profile.model_id, profile.auth_epoch, profile.template_digest));
        (await assertChallenge((await getChallenge(id, ctx)), ctx));
    }));
    return ok(challengeResponse((await getChallenge(id, ctx))), 201);
}
async function readBounded(body: ReadableStream<Uint8Array> | null, maximum: number, afterRead: () => void | Promise<void> = () => { }): Promise<Uint8Array> {
    if (!body)
        throw new ApiError(400, 'capture_required');
    const reader = body.getReader(), chunks: Uint8Array[] = [];
    let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiError(408, 'capture_timeout')), PROVIDER_MS); });
    try {
        for (;;) {
            const result = await Promise.race([reader.read(), deadline]);
            await afterRead();
            if (result.done)
                break;
            chunks.push(result.value);
            length += result.value.length;
            if (length > maximum)
                throw new ApiError(413, 'capture_too_large');
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }
    finally {
        clearTimeout(timer);
        for (const chunk of chunks)
            chunk.fill(0);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function validImage(bytes: Uint8Array, mime: string): boolean {
    if (mime === 'image/jpeg')
        return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (mime === 'image/png')
        return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    return mime === 'image/webp' && bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}
async function uploadProof(request: Request, id: string, index: number, ctx: AppContext): Promise<Response> {
    const challenge = (await getChallenge(id, ctx));
    (await assertChallenge(challenge, ctx));
    if (challenge.purpose === 'registration' && !(await lifecycleOperation(challenge.id, ctx))) {
        const actor = await authenticate(request, ctx);
        if (actor.accountId !== challenge.account_id || actor.sessionId !== challenge.session_id)
            throw new ApiError(403, 'enrollment_scope_invalid');
    }
    if (index < 0 || index >= challenge.required_captures)
        throw new ApiError(400, 'invalid_capture_index');
    const mime = request.headers.get('content-type') ?? '';
    const sizeHeader = request.headers.get('x-lovelies-capture-bytes') ?? '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !/^[1-9][0-9]{0,7}$/.test(sizeHeader))
        throw new ApiError(415, 'capture_format_invalid');
    const size = Number(sizeHeader), captureHash = hash(request.headers.get('x-lovelies-capture-sha256'));
    const prior = (await captures(challenge, ctx));
    if (prior.some(row => row.capture_index === index))
        throw new ApiError(409, 'capture_already_uploaded');
    if (size > MAX_CAPTURE_BYTES || prior.reduce((total, row) => total + row.byte_size, 0) + size > MAX_CAPTURE_BYTES)
        throw new ApiError(413, 'capture_too_large');
    const envelope = { ...deviceEnvelope(challenge), step: 'capture', capture_index: index,
        capture_sha256: captureHash, mime, byte_size: size };
    const key = `face-auth/${challenge.account_id}/${challenge.id}/${crypto.randomUUID()}`;
    const writeId = (await beginFaceChallengeMediaWrite(ctx, challenge.id, 'QUARANTINE', key, async () => {
        (await assertChallenge(challenge, ctx));
        const intent = (await ctx.db.one<Enrollment>('SELECT * FROM face_enrollment_intents WHERE challenge_id=?', challenge.id));
        if (intent || (await lifecycleOperation(id, ctx))) {
            if ((await lifecycleOperation(id, ctx)) && (await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1", challenge.account_id)))
                throw new ApiError(409, 'face_profile_in_flight');
            if (intent && (await unresolvedEnrollmentWriter(intent, ctx)))
                throw new ApiError(409, 'enrollment_in_flight');
            if ((await captures(challenge, ctx)).length !== index)
                throw new ApiError(409, 'capture_index_out_of_order');
        }
    }));
    let bytes: Uint8Array = new Uint8Array(), writeStarted = false, committed = false;
    try {
        // Admission covers signature verification and body reading as well as the
        // eventual PUT, so reconciliation cannot report an unresolved upload absent.
        await verifyDevice(challenge, envelope, request.headers.get('x-lovelies-device-signature'), ctx);
        (await assertChallenge(challenge, ctx));
        bytes = await readBounded(request.body, size, async () => (await assertChallenge(challenge, ctx)));
        if (bytes.length !== size || !validImage(bytes, mime))
            throw new ApiError(400, 'capture_format_invalid');
        if (await digest(bytes) !== captureHash)
            throw new ApiError(400, 'capture_digest_mismatch');
        (await assertChallenge(challenge, ctx));
        writeStarted = true;
        await ctx.env.QUARANTINE.put(key, new Uint8Array(bytes).buffer, { httpMetadata: { contentType: mime }, customMetadata: { purpose: 'face_authentication', challenge_id: challenge.id } });
        (await assertChallenge(challenge, ctx));
        (await ctx.db.transaction(async () => {
            (await assertChallenge(challenge, ctx));
            const current = (await captures(challenge, ctx));
            if (current.some(row => row.capture_index === index))
                throw new ApiError(409, 'capture_already_uploaded');
            if (((await ctx.db.one('SELECT enrollment_key FROM face_enrollment_intents WHERE challenge_id=?', id)) || (await lifecycleOperation(id, ctx))) && current.length !== index)
                throw new ApiError(409, 'capture_index_out_of_order');
            if (current.some(row => row.sha256 === captureHash))
                throw new ApiError(409, 'capture_reused');
            const total = current.reduce((sum, row) => sum + row.byte_size, 0) + size;
            if (total > MAX_CAPTURE_BYTES)
                throw new ApiError(413, 'capture_too_large');
            (await ctx.db.run(`INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at)
        VALUES(?,?,?,?,?,?,?)`, id, index, key, captureHash, mime, size, ctx.now()));
            (await ctx.db.run('UPDATE auth_challenges SET proof_size=? WHERE id=?', total, id));
        }));
        committed = true;
        return ok({ protocol: PROTOCOL, status: 'capture_received', challenge_id: id,
            capture_index: index, capture_sha256: captureHash, byte_size: size });
    }
    finally {
        bytes.fill(0);
        try {
            if (writeStarted && !committed)
                await retireOrphan('QUARANTINE', key, challenge.account_id, ctx);
        }
        finally {
            (await settleMediaWrite(ctx, writeId));
        }
    }
}
async function retireOrphan(bucketName: 'PHOTOS' | 'QUARANTINE', key: string, accountId: string, ctx: AppContext): Promise<void> {
    const id = crypto.randomUUID();
    (await ctx.db.run(`INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,'pending',?)`, id, accountId, bucketName, key, ctx.now()));
    try {
        await ctx.env[bucketName].delete(key);
        if (await ctx.env[bucketName].head(key))
            return;
        (await ctx.db.run(`UPDATE cleanup_intents SET status='verified',verified_at=? WHERE id=?`, ctx.now(), id));
    }
    catch { /* Durable cleanup intent remains pending for maintenance; no raw data is logged. */ }
}
async function privateVerdict(challenge: Challenge, rows: Capture[], ctx: AppContext): Promise<Record<string, any>> {
    verifierAvailable(ctx);
    const body = new FormData(), envelope = { ...deviceEnvelope(challenge), protocol: VERDICT_PROTOCOL,
        protocol_device: DEVICE_PROTOCOL, required_captures: challenge.required_captures,
        poses: challenge.required_captures === 3 ? ['front', 'left', 'right'] : ['front'],
        reference_mode: challenge.purpose === 'replacement' ? 'replace_reference' : challenge.profile_id === null ? 'first_registration' : 'existing_reference',
        model_id: challenge.model_id, reference_digest: challenge.reference_digest,
        capture_manifest: manifest(rows), expires_at: challenge.expires_at };
    body.set('envelope', stable(envelope));
    const sensitive: Uint8Array[] = [];
    try {
        for (const row of rows) {
            const object = await ctx.env.QUARANTINE.get(row.object_key);
            (await assertChallenge(challenge, ctx, 'verifying'));
            if (!object || object.size !== row.byte_size)
                throw new ApiError(409, 'capture_unavailable');
            const bytes = await readBounded(object.body, row.byte_size, async () => (await assertChallenge(challenge, ctx, 'verifying')));
            sensitive.push(bytes);
            if (await digest(bytes) !== row.sha256)
                throw new ApiError(409, 'capture_changed');
            (await assertChallenge(challenge, ctx, 'verifying'));
            body.set(`capture_${row.capture_index}`, new Blob([new Uint8Array(bytes).buffer], { type: row.mime }), `capture_${row.capture_index}`);
        }
        if (challenge.profile_id !== null) {
            const profile = (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', challenge.account_id))!;
            const reference = await ctx.env.PHOTOS.get(profile.template_key);
            (await assertChallenge(challenge, ctx, 'verifying'));
            if (!reference || reference.size > MAX_TEMPLATE_BYTES)
                throw new ApiError(503, 'registered_reference_unavailable');
            const bytes = await readBounded(reference.body, MAX_TEMPLATE_BYTES, async () => (await assertChallenge(challenge, ctx, 'verifying')));
            sensitive.push(bytes);
            if (await digest(bytes) !== challenge.reference_digest)
                throw new ApiError(503, 'registered_reference_unavailable');
            (await assertChallenge(challenge, ctx, 'verifying'));
            body.set('reference', new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' }), 'registered_reference');
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ApiError(503, 'face_verifier_unavailable')); }, PROVIDER_MS); });
        try {
            const response = await Promise.race([ctx.env.FACE_AUTH_VERIFIER!.fetch(new Request('https://face-auth.internal/v1/face-auth/verify', { method: 'POST', body, signal: controller.signal, redirect: 'manual' })), deadline]);
            (await assertChallenge(challenge, ctx, 'verifying'));
            if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''))
                throw new ApiError(503, 'face_verifier_unavailable');
            const bytes = await Promise.race([readBounded(response.body, 128 * 1024, async () => (await assertChallenge(challenge, ctx, 'verifying'))), deadline]);
            try {
                return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            }
            catch {
                throw new ApiError(503, 'face_verdict_invalid');
            }
            finally {
                bytes.fill(0);
            }
        }
        catch (error) {
            if (error instanceof ApiError)
                throw error;
            throw new ApiError(503, 'face_verifier_unavailable');
        }
        finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
    finally {
        for (const bytes of sensitive)
            bytes.fill(0);
    }
}
function validateVerdict(verdict: Record<string, any>, challenge: Challenge, rows: Capture[], ctx: AppContext): void {
    const expected = { protocol: VERDICT_PROTOCOL, challenge_id: challenge.id, nonce: challenge.nonce,
        purpose: challenge.purpose, account_id: challenge.account_id, device_id: challenge.device_id,
        device_revision: challenge.device_revision, profile_id: challenge.profile_id,
        profile_revision: challenge.profile_revision, model_id: challenge.model_id,
        policy_version: challenge.policy_version, reference_digest: challenge.reference_digest,
        reference_mode: challenge.purpose === 'replacement' ? 'replace_reference' : challenge.profile_id === null ? 'first_registration' : 'existing_reference' };
    if (Object.entries(expected).some(([key, value]) => verdict[key] !== value) ||
        !Array.isArray(verdict.capture_manifest) || stable(verdict.capture_manifest) !== stable(manifest(rows)) ||
        !Number.isSafeInteger(verdict.verified_at) || verdict.verified_at < ctx.now() - 60000 ||
        verdict.verified_at > ctx.now() + 5000 || !Number.isSafeInteger(verdict.expires_at) ||
        verdict.expires_at <= ctx.now() || verdict.expires_at > challenge.expires_at ||
        typeof verdict.receipt_id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(verdict.receipt_id))
        throw new ApiError(503, 'face_verdict_invalid');
    // Owner policy: registered-face comparison without liveness/PAD. Device
    // signatures bind bytes to this single-use challenge; they do not attest
    // that the bytes originated at a camera sensor.
    if (Object.hasOwn(verdict, 'capture_rejection')) {
        if (!verdict.capture_rejection || typeof verdict.capture_rejection !== 'object' || Array.isArray(verdict.capture_rejection))
            throw new ApiError(503, 'face_verdict_invalid');
        const rejection = record(verdict.capture_rejection);
        if (verdict.identity_verified !== false || (Object.hasOwn(verdict, 'reference_match') && verdict.reference_match !== false) ||
            (Object.hasOwn(verdict, 'enrollment_verified') && verdict.enrollment_verified !== false) ||
            ['registered_reference', 'template_base64', 'template_sha256'].some(key => Object.hasOwn(verdict, key)) ||
            Object.keys(rejection).length !== 2 || !Object.hasOwn(rejection, 'code') || !Object.hasOwn(rejection, 'capture_index') ||
            !['no_face', 'multiple_faces', 'quality_low', 'invalid_image'].includes(rejection.code) ||
            !Number.isSafeInteger(rejection.capture_index) || rejection.capture_index < 0 || rejection.capture_index >= rows.length)
            throw new ApiError(503, 'face_verdict_invalid');
        // A usable session has not expired. The terminal failed challenge requires
        // reconciliation and a fresh signed generation; accepted captures are immutable.
        throw new ApiError(422, 'face_capture_' + rejection.code);
    }
    for (const field of ['identity_verified']) {
        if (verdict[field] === false)
            throw new ApiError(401, 'face_verification_failed');
        if (verdict[field] !== true)
            throw new ApiError(503, 'face_verdict_invalid');
    }
    if (challenge.profile_id !== null) {
        if (verdict.reference_match === false)
            throw new ApiError(401, 'face_verification_failed');
        if (verdict.reference_match !== true || (challenge.purpose !== 'replacement' && verdict.registered_reference != null))
            throw new ApiError(503, 'face_verdict_invalid');
    }
    else {
        if (verdict.enrollment_verified !== true)
            throw new ApiError(503, 'face_verdict_invalid');
    }
    if (challenge.purpose === 'replacement' && verdict.enrollment_verified !== true)
        throw new ApiError(503, 'face_verdict_invalid');
}
async function complete(request: Request, purpose: 'registration' | 'login' | 'lifecycle', ctx: AppContext): Promise<Response> {
    verifierAvailable(ctx);
    const input = await jsonBody(request, 2048), challenge = (await getChallenge(uuid(input.challenge_id), ctx));
    if (Object.keys(input).some(key => !['challenge_id', 'device_signature'].includes(key)) || (purpose === 'lifecycle' ? !(await lifecycleOperation(challenge.id, ctx)) : challenge.purpose !== purpose))
        throw new ApiError(400, 'challenge_scope_invalid');
    (await assertChallenge(challenge, ctx));
    const recovery = (await ctx.db.one<RecoveryIntent>('SELECT * FROM face_recovery_intents WHERE challenge_id=?', challenge.id));
    const lifecycle = (await lifecycleOperation(challenge.id, ctx));
    if (lifecycle && purpose !== 'lifecycle')
        throw new ApiError(400, 'challenge_scope_invalid');
    if (purpose === 'registration') {
        const actor = await authenticate(request, ctx);
        if (actor.accountId !== challenge.account_id || actor.sessionId !== challenge.session_id)
            throw new ApiError(403, 'enrollment_scope_invalid');
    }
    const rows = (await captures(challenge, ctx));
    if (rows.length !== challenge.required_captures || rows.some((row, index) => row.capture_index !== index) ||
        new Set(rows.map(row => row.sha256)).size !== rows.length ||
        rows.reduce((total, row) => total + row.byte_size, 0) > MAX_CAPTURE_BYTES)
        throw new ApiError(409, 'captures_incomplete');
    await verifyDevice(challenge, { ...deviceEnvelope(challenge), step: 'complete', capture_manifest: manifest(rows) }, input.device_signature, ctx);
    (await ctx.db.transaction(async () => {
        (await assertChallenge(challenge, ctx));
        (await ctx.db.run(`UPDATE auth_challenges SET status='verifying',attempts=attempts+1 WHERE id=?`, challenge.id));
    }));
    let templateKey: string | null = null, templateWriteStarted = false, committed = false;
    activeFaceVerifiers(ctx).add(challenge.id);
    try {
        const verdict = await privateVerdict(challenge, rows, ctx);
        (await assertChallenge(challenge, ctx, 'verifying'));
        validateVerdict(verdict, challenge, rows, ctx);
        let profileId = challenge.profile_id, revision = challenge.profile_revision, modelId = challenge.model_id;
        let templateDigest = challenge.reference_digest;
        if (profileId === null || challenge.purpose === 'replacement') {
            let bytes: Uint8Array;
            try {
                const reference = record(verdict.registered_reference);
                revision = boundedText(reference.revision);
                modelId = boundedText(reference.model_id);
                templateDigest = hash(reference.template_sha256);
                if (challenge.purpose === 'replacement' && (revision === challenge.profile_revision))
                    throw new ApiError(503, 'face_verdict_invalid');
                bytes = decodeBase64url(reference.template_base64, MAX_TEMPLATE_BYTES);
            }
            catch {
                throw new ApiError(503, 'face_verdict_invalid');
            }
            try {
                if (!bytes.length || await digest(bytes) !== templateDigest)
                    throw new ApiError(503, 'face_verdict_invalid');
                (await assertChallenge(challenge, ctx, 'verifying'));
                profileId ??= crypto.randomUUID();
                templateKey = `registered-face/${challenge.account_id}/${profileId}/${crypto.randomUUID()}`;
                const writeId = (await beginFaceChallengeMediaWrite(ctx, challenge.id, 'PHOTOS', templateKey, async () => (await assertChallenge(challenge, ctx, 'verifying'))));
                templateWriteStarted = true;
                try {
                    await ctx.env.PHOTOS.put(templateKey, new Uint8Array(bytes).buffer, { httpMetadata: { contentType: 'application/octet-stream' },
                        customMetadata: { purpose: 'registered_face_reference', model_id: modelId!, revision: revision!, template_digest: templateDigest! } });
                }
                finally {
                    (await settleMediaWrite(ctx, writeId));
                }
                (await assertChallenge(challenge, ctx, 'verifying'));
                if (lifecycle) {
                    const head = await ctx.env.PHOTOS.head(templateKey!);
                    (await assertChallenge(challenge, ctx, 'verifying'));
                    if (!head || head.size !== bytes.length || head.customMetadata?.revision !== revision || head.customMetadata?.model_id !== modelId || head.customMetadata?.template_digest !== templateDigest)
                        throw new ApiError(503, 'registered_reference_unavailable');
                    const stored = await ctx.env.PHOTOS.get(templateKey!);
                    (await assertChallenge(challenge, ctx, 'verifying'));
                    if (!stored || stored.size !== bytes.length)
                        throw new ApiError(503, 'registered_reference_unavailable');
                    const checked = await readBounded(stored.body, MAX_TEMPLATE_BYTES, async () => (await assertChallenge(challenge, ctx, 'verifying')));
                    try {
                        if (await digest(checked) !== templateDigest)
                            throw new ApiError(503, 'registered_reference_unavailable');
                        (await assertChallenge(challenge, ctx, 'verifying'));
                    }
                    finally {
                        checked.fill(0);
                    }
                }
            }
            finally {
                bytes.fill(0);
            }
        }
        const account = (await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', challenge.account_id))!;
        const profileEpoch = (purpose === 'registration' || lifecycle) ? (challenge.profile_auth_epoch ?? 0) + 1 : challenge.profile_auth_epoch!;
        const accountEpoch = purpose === 'registration' || recovery || lifecycle ? challenge.auth_epoch + 1 : challenge.auth_epoch;
        const prepared = await prepareSession({ accountId: account.id, roles: accountRoles(account.roles_json),
            authEpoch: accountEpoch, authMethod: 'registered_face', profileRevision: revision!, profileEpoch,
            consentId: challenge.consent_id, deviceId: challenge.device_id, deviceRevision: challenge.device_revision }, ctx);
        (await ctx.db.transaction(async () => {
            (await assertChallenge(challenge, ctx, 'verifying'));
            if (purpose === 'registration') {
                if (challenge.profile_id === null) {
                    (await ctx.db.run(`INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,
            auth_enabled,auth_epoch,auth_consent_id,consent_id) VALUES(?,?,?,?,?,?,'active',1,?,?,NULL)`, account.id, profileId!, revision!, modelId!, templateKey!, templateDigest!, profileEpoch, challenge.consent_id));
                }
                else {
                    (await ctx.db.run(`UPDATE face_profiles SET auth_enabled=1,auth_epoch=?,auth_consent_id=? WHERE account_id=?`, profileEpoch, challenge.consent_id, account.id));
                }
                (await ctx.db.run('UPDATE consents SET profile_revision=? WHERE id=?', revision!, challenge.consent_id));
                (await ctx.db.run(`UPDATE auth_devices SET status='active' WHERE id=?`, challenge.device_id));
                (await ctx.db.run(`UPDATE face_enrollment_intents SET completed_profile_id=?,completed_profile_revision=?,
          completed_model_id=?,completed_reference_digest=?,completed_auth_epoch=?,completed_profile_epoch=? WHERE challenge_id=?
          AND completed_profile_id IS NULL`, profileId!, revision!, modelId!, templateDigest!, accountEpoch, profileEpoch, challenge.id));
                (await ctx.db.run(`UPDATE accounts SET identity_state='registered_face',auth_epoch=? WHERE id=?`, accountEpoch, account.id));
                (await ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE account_id=? AND revoked_at IS NULL', ctx.now(), ctx.now(), account.id));
                (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND id<>? AND used_at IS NULL`, ctx.now(), account.id, challenge.id));
            }
            if (lifecycle)
                (await commitLifecycle(lifecycle, challenge, {
                    account_id: account.id, id: profileId!, revision: revision!, model_id: modelId!,
                    template_key: templateKey ?? (await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?', account.id))!.template_key,
                    template_digest: templateDigest!, status: 'active', auth_enabled: 1, auth_epoch: profileEpoch,
                    auth_consent_id: challenge.consent_id, consent_id: null
                }, ctx));
            if (recovery) {
                const key = (await recoveryAuthority(recovery, ctx)), now = ctx.now();
                (await ctx.db.run('UPDATE face_recovery_keys SET consumed_at=? WHERE id=?', now, key.id));
                (await ctx.db.run(`UPDATE face_recovery_intents SET completed_at=?,completed_auth_epoch=?
          WHERE account_id=? AND recovery_request_id=?`, now, accountEpoch, account.id, recovery.recovery_request_id));
                // One existing reference and consent are retained. A lost device keeps
                // neither a usable key handle nor any session after replacement.
                (await ctx.db.run(`UPDATE auth_devices SET status='revoked',face_handle=NULL,revision=? WHERE account_id=? AND id<>?`, crypto.randomUUID(), account.id, challenge.device_id));
                (await ctx.db.run(`UPDATE auth_devices SET status='active' WHERE id=?`, challenge.device_id));
                (await ctx.db.run('UPDATE accounts SET auth_epoch=? WHERE id=?', accountEpoch, account.id));
                (await ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE account_id=? AND revoked_at IS NULL', now, now, account.id));
                (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND id<>? AND used_at IS NULL`, now, account.id, challenge.id));
            }
            (await ctx.db.run(`UPDATE auth_challenges SET status='used',used_at=? WHERE id=?`, ctx.now(), challenge.id));
            (await insertPreparedSession(prepared, ctx));
        }));
        committed = true;
        return ok({ ...prepared.credentials, protocol: PROTOCOL, status: 'authenticated',
            profile_id: profileId, profile_revision: revision, model_id: modelId, device_id: challenge.device_id });
    }
    catch (error) {
        (await ctx.db.transaction(async () => {
            const current = (await getChallenge(challenge.id, ctx));
            if (current.status === 'verifying' && current.used_at === null) {
                const retry = error instanceof ApiError && error.status === 503 && current.expires_at > ctx.now() && current.attempts < 3;
                (await ctx.db.run('UPDATE auth_challenges SET status=?,used_at=? WHERE id=?', retry ? 'pending' : 'failed', retry ? null : ctx.now(), current.id));
            }
        }));
        throw error;
    }
    finally {
        activeFaceVerifiers(ctx).delete(challenge.id);
        if (templateWriteStarted && !committed && templateKey)
            await retireOrphan('PHOTOS', templateKey, challenge.account_id, ctx);
        // Maintenance retries failures; response/session issuance never depends on cleanup availability.
        try {
            await cleanupFaceProofs(ctx);
        }
        catch { /* Keep unretired proof rows for the next alarm. */ }
    }
}
/** Expired/consumed raw captures are physically deleted before their rows retire. */
export async function nextFaceRecoveryAt(ctx: AppContext): Promise<number | null> {
    return (await ctx.db.one<{
        due: number | null;
    }>(`SELECT min(due) due FROM (
    SELECT expires_at due FROM face_recovery_intents UNION ALL
    SELECT CASE WHEN revoked_at IS NOT NULL OR consumed_at IS NOT NULL THEN created_at+?
      ELSE expires_at END due FROM face_recovery_keys)`, RECOVERY_RECEIPT_MS))?.due ?? null;
}
export async function cleanupFaceProofs(ctx: AppContext): Promise<void> {
    const rows = (await ctx.db.all<Capture>(`SELECT p.* FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id
    WHERE c.expires_at<=? OR c.used_at IS NOT NULL OR c.status IN('failed','cancelled','used')
    ORDER BY p.created_at LIMIT 100`, ctx.now()));
    for (const row of rows) {
        try {
            await ctx.env.QUARANTINE.delete(row.object_key);
            if (await ctx.env.QUARANTINE.head(row.object_key))
                continue;
            (await ctx.db.transaction(async () => {
                const challenge = (await getChallenge(row.challenge_id, ctx));
                if (challenge.expires_at > ctx.now() && challenge.used_at === null && !['failed', 'cancelled', 'used'].includes(challenge.status))
                    return;
                (await ctx.db.run('DELETE FROM auth_capture_proofs WHERE challenge_id=? AND capture_index=? AND object_key=?', row.challenge_id, row.capture_index, row.object_key));
            }));
        }
        catch { /* The existing row is the durable, bounded retry obligation. */ }
    }
    (await ctx.db.transaction(async () => (await ctx.db.run(`DELETE FROM face_enrollment_intents WHERE (account_id,enrollment_key) IN(
    SELECT i.account_id,i.enrollment_key FROM face_enrollment_intents i JOIN auth_challenges c ON c.id=i.challenge_id
    WHERE (i.expires_at<=? OR i.revoked_at IS NOT NULL) AND (c.expires_at<=? OR c.used_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM media_write_intents w WHERE w.account_id=i.account_id AND w.status='pending')
    AND NOT EXISTS(SELECT 1 FROM auth_capture_proofs p JOIN auth_challenges pc ON pc.id=p.challenge_id WHERE pc.device_id=i.device_id)
    LIMIT 100)`, ctx.now(), ctx.now()))));
    (await ctx.db.transaction(async () => {
        const retired = (await ctx.db.all<RecoveryIntent>(`SELECT i.* FROM face_recovery_intents i
      JOIN face_recovery_keys k ON k.id=i.key_id WHERE (i.expires_at<=? OR k.revoked_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM media_write_intents w WHERE w.account_id=i.account_id AND w.status='pending')
      AND NOT EXISTS(SELECT 1 FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id WHERE c.device_id=i.device_id)
      AND NOT EXISTS(SELECT 1 FROM auth_challenges c WHERE c.id=i.challenge_id AND c.status='verifying' AND c.expires_at>?)
      LIMIT 100`, ctx.now(), ctx.now()));
        for (const intent of retired) {
            if (activeFaceVerifiers(ctx).has(intent.challenge_id))
                continue;
            if (intent.completed_at === null) {
                (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE id=?`, ctx.now(), intent.challenge_id));
                (await ctx.db.run(`UPDATE auth_devices SET status='revoked',face_handle=NULL WHERE id=? AND status='pending'`, intent.device_id));
            }
            (await ctx.db.run('DELETE FROM face_recovery_intents WHERE account_id=? AND recovery_request_id=?', intent.account_id, intent.recovery_request_id));
        }
        // Receipt history outlives pending proof cleanup; no active backup is pruned.
        (await ctx.db.run(`DELETE FROM face_recovery_keys WHERE id IN(SELECT k.id FROM face_recovery_keys k
      WHERE (k.expires_at<=? OR k.revoked_at IS NOT NULL OR k.consumed_at IS NOT NULL)
      AND k.created_at<=? AND NOT EXISTS(SELECT 1 FROM face_recovery_intents i WHERE i.key_id=k.id) LIMIT 100)`, ctx.now(), ctx.now() - RECOVERY_RECEIPT_MS));
    }));
}
export async function handleFaceAuth(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/auth/face/policy') {
        verifierAvailable(ctx);
        return ok({ protocol: PROTOCOL, policy_version: policy(ctx), required_captures: 3,
            poses: ['front', 'left', 'right'], available: true });
    }
    if (request.method === 'POST' && path === '/auth/face/registration/challenge')
        return (await registrationChallenge(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/registration/recovery')
        return (await recoverEnrollment(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/registration/resume')
        return (await resumeEnrollment(request, ctx));
    if (['GET', 'POST', 'DELETE'].includes(request.method) && path === '/auth/face/recovery/key')
        return (await manageRecoveryKey(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/recovery/challenge')
        return (await startAccountRecovery(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/recovery/status')
        return (await accountRecoveryStatus(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/recovery/resume')
        return (await resumeAccountRecovery(request, ctx));
    if (request.method === 'POST' && path === '/auth/face/challenge')
        return (await loginChallenge(request, ctx));
    const proof = /^\/auth\/face\/proof\/([0-9a-f-]{36})\/([0-2])$/.exec(path);
    if (request.method === 'PUT' && proof)
        return (await uploadProof(request, uuid(proof[1]), Number(proof[2]), ctx));
    if (request.method === 'POST' && path === '/auth/face/registration/complete')
        return (await complete(request, 'registration', ctx));
    if (request.method === 'POST' && path === '/auth/face/profile/complete')
        return (await complete(request, 'lifecycle', ctx));
    if (request.method === 'POST' && path === '/auth/face/complete')
        return (await complete(request, 'login', ctx));
    return null;
}
