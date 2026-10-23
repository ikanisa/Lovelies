import { cancelDeviceLifecycle } from './face-profile';
import { ApiError, digest, jsonBody, ok, uuid, type Actor, type AppContext } from './types';

const ACCESS_MS = 900_000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUER = 'lovelies-cloudflare';
const AUDIENCE = 'lovelies-clients';
const encoder = new TextEncoder();

export type AccountRow = {
  id: string; name: string; roles_json: string; disabled_at: number | null;
  auth_epoch: number; identity_state: 'anonymous' | 'registered_face';
};
export type SessionRow = {
  id: string; account_id: string; refresh_hash: string; expires_at: number;
  refresh_expires_at: number; revoked_at: number | null; auth_epoch: number;
  auth_method: 'anonymous' | 'registered_face'; face_profile_revision: string | null;
  face_consent_id: string | null; device_id: string | null; created_at: number;
  refresh_consumed_at: number | null; face_profile_epoch: number | null;
  device_revision: string | null;
};
export type SessionSpec = {
  accountId: string; roles: string[]; authEpoch: number;
  authMethod: 'anonymous' | 'registered_face'; profileRevision?: string;
  profileEpoch?: number; consentId?: string; deviceId?: string; deviceRevision?: string;
};
export type PreparedSession = {
  spec: SessionSpec; id: string; refreshHash: string; createdAt: number;
  expiresAt: number; refreshExpiresAt: number;
  credentials: { access_token: string; refresh_token: string; expires_in: 900;
    token_type: 'Bearer'; roles: string[]; auth_method: 'anonymous' | 'registered_face'; account_id: string };
};

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBase64url(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiError(400, 'invalid_encoding');
  let binary: string;
  try { binary = atob(value.replace(/-/g, '+').replace(/_/g, '/')); }
  catch { throw new ApiError(400, 'invalid_encoding'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length > maximum || base64url(bytes) !== value) throw new ApiError(400, 'invalid_encoding');
  return bytes;
}
export const opaque = (prefix: string): string => `${prefix}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

function readRoles(value: string, retiredStorage = false): string[] {
  let roles: unknown;
  try { roles = JSON.parse(value); } catch { throw new ApiError(401, 'session_invalid'); }
  const allowed = retiredStorage ? ['user', 'admin', 'photographer'] : ['user', 'admin'];
  if (!Array.isArray(roles) || !roles.length || roles.length > allowed.length || new Set(roles).size !== roles.length || roles.some(role => !allowed.includes(role))) throw new ApiError(401, 'session_invalid');
  const active = roles.filter(role => role !== 'photographer');
  if (!active.length) throw new ApiError(401, 'session_invalid');
  return active as string[];
}
export function accountRoles(value: string): string[] {
  // Existing durable rows may retain this retired role. It grants no capability
  // and never enters newly issued credentials; old role-bearing tokens fail.
  return readRoles(value, true);
}
function sameRoles(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function secret(ctx: AppContext): Uint8Array {
  const value = ctx.env.AUTH_SIGNING_SECRET;
  if (typeof value !== 'string' || encoder.encode(value).length < 32) throw new ApiError(503, 'authentication_unavailable');
  return encoder.encode(value);
}
async function hmacKey(ctx: AppContext): Promise<CryptoKey> {
  const bytes = secret(ctx);
  try { return await crypto.subtle.importKey('raw', new Uint8Array(bytes).buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
  finally { bytes.fill(0); }
}

/** Durable account/session checks. This explicit weaker guard is enrollment-only. */
export function assertEnrollmentActor(actor: Actor, ctx: AppContext, allowExpired = false): void {
  const account = ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', actor.accountId);
  const session = ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?', actor.sessionId, actor.accountId);
  const now = ctx.now();
  if (!account || !session || account.disabled_at !== null || session.revoked_at !== null ||
      session.auth_epoch !== account.auth_epoch || actor.authEpoch !== account.auth_epoch ||
      session.auth_method !== actor.authMethod || session.expires_at !== actor.expiresAt ||
      (!allowExpired && session.expires_at <= now) || session.refresh_expires_at <= now ||
      !sameRoles(accountRoles(account.roles_json), actor.roles)) throw new ApiError(401, 'session_invalid');
  if (actor.authMethod === 'anonymous') {
    if (account.identity_state !== 'anonymous' || !sameRoles(actor.roles, ['user'])) throw new ApiError(401, 'session_invalid');
    return;
  }
  if (actor.authMethod !== 'registered_face' || account.identity_state !== 'registered_face') throw new ApiError(401, 'session_invalid');
  const valid = ctx.db.one<{ id: string }>(
    `SELECT p.id FROM face_profiles p JOIN consents c ON c.id=p.auth_consent_id
     JOIN auth_devices d ON d.id=? AND d.account_id=p.account_id
     WHERE p.account_id=? AND p.status='active' AND p.auth_enabled=1
       AND p.revision=? AND p.auth_epoch=? AND p.auth_consent_id=?
       AND c.account_id=p.account_id AND c.purpose='face_authentication' AND c.status='granted'
       AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
       AND c.policy_version=? AND (c.profile_revision IS NULL OR c.profile_revision=p.revision)
       AND d.status='active' AND d.revision=?`,
    session.device_id, account.id, session.face_profile_revision, session.face_profile_epoch,
    session.face_consent_id, now, ctx.env.FACE_AUTH_POLICY_VERSION ?? '', session.device_revision,
  );
  if (!valid) throw new ApiError(401, 'registered_face_session_invalid');
}

/** All protected product capabilities require a current verified face session. */
export function assertActor(actor: Actor, ctx: AppContext): void {
  assertEnrollmentActor(actor, ctx);
  if (actor.authMethod !== 'registered_face') throw new ApiError(403, 'registered_face_required');
}

export async function authenticate(request: Request, ctx: AppContext): Promise<Actor> {
  const authorization = request.headers.get('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization)) throw new ApiError(401, 'authentication_required');
  const token = authorization.slice(7), parts = token.split('.');
  if (parts.length !== 3) throw new ApiError(401, 'session_invalid');
  let header: Record<string, unknown>, claims: Record<string, unknown>, signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(parts[0], 1024)));
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(parts[1], 4096)));
    signature = decodeBase64url(parts[2], 32);
  } catch { throw new ApiError(401, 'session_invalid'); }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !claims || typeof claims !== 'object' || Array.isArray(claims) || header.alg !== 'HS256' || header.typ !== 'JWT' || Object.keys(header).some(key => !['alg', 'typ'].includes(key)) || signature.length !== 32) throw new ApiError(401, 'session_invalid');
  const key = await hmacKey(ctx);
  const verified = await crypto.subtle.verify('HMAC', key, new Uint8Array(signature).buffer, encoder.encode(`${parts[0]}.${parts[1]}`).buffer);
  signature.fill(0);
  if (!verified || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      (claims.exp as number) - (claims.iat as number) !== 900 ||
      (claims.iat as number) * 1000 > ctx.now() + 5000 || (claims.exp as number) * 1000 <= ctx.now() ||
      !Number.isSafeInteger(claims.auth_epoch) || (claims.auth_epoch as number) < 1 ||
      !['anonymous', 'registered_face'].includes(claims.auth_method as string)) throw new ApiError(401, 'session_invalid');
  let accountId: string, sessionId: string, roles: string[];
  try { accountId = uuid(claims.sub); sessionId = uuid(claims.jti); roles = readRoles(JSON.stringify(claims.roles)); }
  catch { throw new ApiError(401, 'session_invalid'); }
  const actor: Actor = { accountId, sessionId, roles, expiresAt: (claims.exp as number) * 1000,
    authEpoch: claims.auth_epoch as number, authMethod: claims.auth_method as Actor['authMethod'] };
  assertEnrollmentActor(actor, ctx); // Re-read durable authority after every crypto await.
  return actor;
}

/** Cryptography is prepared before a synchronous transaction; no session yet exists. */
export async function prepareSession(spec: SessionSpec, ctx: AppContext): Promise<PreparedSession> {
  readRoles(JSON.stringify(spec.roles));
  const createdAt = ctx.now(), issuedSeconds = Math.floor(createdAt / 1000);
  const id = crypto.randomUUID(), refreshToken = opaque('lvs_');
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(encoder.encode(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: spec.accountId,
    jti: id, roles: spec.roles, auth_epoch: spec.authEpoch, auth_method: spec.authMethod,
    iat: issuedSeconds, exp: issuedSeconds + ACCESS_MS / 1000 })));
  const key = await hmacKey(ctx);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`).buffer));
  const accessToken = `${header}.${body}.${base64url(signature)}`; signature.fill(0);
  const refreshHash = await digest(refreshToken);
  return { spec, id, refreshHash, createdAt, expiresAt: (issuedSeconds + 900) * 1000,
    refreshExpiresAt: createdAt + REFRESH_MS,
    credentials: { access_token: accessToken, refresh_token: refreshToken, expires_in: 900,
      token_type: 'Bearer', roles: [...spec.roles], auth_method: spec.authMethod, account_id: spec.accountId } };
}

/** Caller must recheck its current authority in the same transaction before insertion. */
export function insertPreparedSession(prepared: PreparedSession, ctx: AppContext): void {
  const { spec } = prepared;
  const account = ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', spec.accountId);
  if (!account || account.disabled_at !== null || account.auth_epoch !== spec.authEpoch ||
      account.identity_state !== spec.authMethod || !sameRoles(accountRoles(account.roles_json), spec.roles) ||
      prepared.expiresAt <= ctx.now()) throw new ApiError(401, 'session_changed');
  ctx.db.run(`INSERT INTO sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,
    auth_method,face_profile_revision,face_consent_id,device_id,created_at,face_profile_epoch,device_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, prepared.id, spec.accountId, prepared.refreshHash,
    prepared.expiresAt, prepared.refreshExpiresAt, spec.authEpoch, spec.authMethod,
    spec.profileRevision ?? null, spec.consentId ?? null, spec.deviceId ?? null,
    prepared.createdAt, spec.profileEpoch ?? null, spec.deviceRevision ?? null);
  assertEnrollmentActor({ accountId: spec.accountId, sessionId: prepared.id, roles: spec.roles,
    expiresAt: prepared.expiresAt, authEpoch: spec.authEpoch, authMethod: spec.authMethod }, ctx);
}

function actorForSession(session: SessionRow, account: AccountRow): Actor {
  return { accountId: account.id, sessionId: session.id, roles: accountRoles(account.roles_json),
    expiresAt: session.expires_at, authEpoch: session.auth_epoch, authMethod: session.auth_method };
}

export async function handleAuth(request: Request, ctx: AppContext): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method === 'POST' && path === '/auth/anonymous') {
    const body = await jsonBody(request, 1024);
    if (Object.keys(body).length) throw new ApiError(400, 'anonymous_scope_invalid');
    const accountId = crypto.randomUUID();
    const prepared = await prepareSession({ accountId, roles: ['user'], authEpoch: 1, authMethod: 'anonymous' }, ctx);
    ctx.db.transaction(() => {
      ctx.db.run(`INSERT INTO accounts(id,name,roles_json,auth_epoch,identity_state,created_at) VALUES(?,'','["user"]',1,'anonymous',?)`, accountId, ctx.now());
      ctx.db.run('INSERT INTO account_preferences(account_id,updated_at) VALUES(?,?)', accountId, ctx.now());
      insertPreparedSession(prepared, ctx);
    });
    return ok(prepared.credentials, 201);
  }
  if (request.method === 'GET' && path === '/me') {
    const actor = await authenticate(request, ctx);
    assertEnrollmentActor(actor, ctx);
    const account = ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', actor.accountId)!;
    const profile = ctx.db.one<{ id: string; revision: string }>('SELECT id,revision FROM face_profiles WHERE account_id=? AND status=\'active\'', actor.accountId);
    return ok({ user_id: actor.accountId, name: account.name, roles: actor.roles,
      auth_method: actor.authMethod, authenticated: actor.authMethod === 'registered_face',
      profile_scope: actor.authMethod === 'registered_face' ? 'registered_face_profile' : 'anonymous_enrollment',
      ...(actor.authMethod === 'registered_face' && profile ? { profile_id: profile.id, profile_revision: profile.revision } : {}) });
  }
  if (request.method === 'POST' && path === '/auth/session/refresh') {
    const body = await jsonBody(request, 1024);
    if (typeof body.refresh_token !== 'string' || !/^lvs_[A-Za-z0-9_-]{43}$/.test(body.refresh_token) || Object.keys(body).some(key => key !== 'refresh_token')) throw new ApiError(401, 'refresh_invalid');
    const hash = await digest(body.refresh_token);
    const old = ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE refresh_hash=?', hash);
    const account = old && ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?', old.account_id);
    if (!old || !account || old.refresh_consumed_at !== null) throw new ApiError(401, 'refresh_invalid');
    const actor = actorForSession(old, account);
    assertEnrollmentActor(actor, ctx, true);
    const prepared = await prepareSession({ accountId: actor.accountId, roles: actor.roles,
      authEpoch: actor.authEpoch, authMethod: old.auth_method, profileRevision: old.face_profile_revision ?? undefined,
      profileEpoch: old.face_profile_epoch ?? undefined, consentId: old.face_consent_id ?? undefined,
      deviceId: old.device_id ?? undefined, deviceRevision: old.device_revision ?? undefined }, ctx);
    ctx.db.transaction(() => {
      assertEnrollmentActor(actor, ctx, true);
      const current = ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND refresh_hash=?', old.id, hash);
      if (!current || current.refresh_consumed_at !== null) throw new ApiError(401, 'refresh_invalid');
      ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?', ctx.now(), ctx.now(), old.id);
      insertPreparedSession(prepared, ctx);
    });
    return ok(prepared.credentials);
  }
  if (request.method === 'POST' && path === '/auth/logout') {
    const actor = await authenticate(request, ctx);
    ctx.db.transaction(() => {
      assertEnrollmentActor(actor, ctx);
      const device=ctx.db.one<{device_id:string|null}>('SELECT device_id FROM sessions WHERE id=? AND account_id=?',actor.sessionId,actor.accountId)?.device_id ?? null;
      cancelDeviceLifecycle(actor.accountId,device,ctx);
      ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?', ctx.now(), ctx.now(), actor.sessionId);
      ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=? WHERE session_id=? AND used_at IS NULL`, ctx.now(), actor.sessionId);
    });
    return ok({ status: 'logged_out' });
  }
  return null;
}
