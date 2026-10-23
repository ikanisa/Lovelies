import {
  LoveliesClientError, fail, object, text, uuid, integer, rows, ids, operationKey,
  source, checkSource, expiry, freeze, copy, roles, credentials, samePairs,
  effectiveSelection, previewPayload, snapshotResponse, previewResponse,
  shareOutcome, receiptResponse, decisionResponse,
} from './contracts.mjs';
import { FACE_PROTOCOL, MAX_FACE_CAPTURE_BYTES, faceChallenge, publicDeviceKey, deviceSignature,
  faceSigningBytes, faceCaptureDigest, faceCapturePayload, faceCompletionPayload } from './face-contracts.mjs';

export { LoveliesClientError, effectiveSelection } from './contracts.mjs';
export { faceSigningBytes, faceCapturePayload, faceCompletionPayload } from './face-contracts.mjs';

/**
 * @typedef {{accountId:string,roles:string[],authMethod:'anonymous'|'registered_face',authenticated:boolean,expiresAt:number,appReview:boolean,epoch:number}} SessionSummary
 * @typedef {{accountId:string,source:'personal',action:string,operationKey:string,payload:object}} OperationIntent
 * @typedef {{baseUrl:string,mediaOrigin?:string,fetch?:typeof globalThis.fetch,timeoutMs?:number,maxJsonBytes?:number,maxPreviewBytes?:number,now?:()=>number,onOperationPrepared?:(intent:OperationIntent)=>Promise<void>|void}} ClientOptions
 * @typedef {{id:string,name:string,identity_state:'anonymous'|'registered_face',status:'active'|'deleted',matching_status:'active'|'paused'|'absent'|null,roles:string[],created_at:number,active_sessions:number,open_support:number,open_reports:number,pending_privacy:number}} AdminUserSummary
 * @typedef {{users:AdminUserSummary[],page:{limit:number,has_more:boolean,next_cursor:string|null}}} AdminUserPage
 * @typedef {{id:string,auth_method:'anonymous'|'registered_face',created_at:number,expires_at:number,status:'active'|'refreshable'|'expired'|'revoked'}} AdminSession
 * @typedef {{user:AdminUserSummary,sessions:AdminSession[],cases:{support:object[],safety:object[],privacy:object[]},history:object[],limits:{sessions:number,cases_per_kind:number,history:number},has_more:{sessions:boolean,support:boolean,safety:boolean,privacy:boolean,history:boolean}}} AdminUserDetail
 */

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_api_origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('invalid_api_origin');
  return url.origin;
}
function apiLocation(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_api_origin'); }
  const path = url.pathname.replace(/\/$/, '');
  if (url.username || url.password || url.search || url.hash || (path && path !== '/functions/v1/lovelies-api')) fail('invalid_api_origin');
  return { origin: origin(url.origin), prefix: path };
}
function metadata(rowsValue, gallery = false) {
  const seen = new Set();
  return rows(rowsValue, 100).map((item) => {
    object(item); const id = uuid(item.id);
    if (seen.has(id)) fail('duplicate_id');
    seen.add(id);
    if (gallery) { uuid(item.media_asset_id); uuid(item.match_id); text(item.visibility); }
    else if (!['received', 'contributions'].includes(item.source)) fail('photo_scope_invalid');
    if (item.media_source != null && item.media_source !== 'personal') fail('source_mismatch');
    for (const key of ['width', 'height']) if (item[key] != null) integer(item[key], 1, 100000);
    if (item.orientation != null) integer(item.orientation, 1, 8);
    return copy(item);
  });
}

const adminChoice = (value, choices) => {
  if (!choices.includes(value)) fail('admin_response_invalid');
  return value;
};
const adminString = (value, maximum, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail('admin_response_invalid');
  return value;
};
const adminSupportSubject = (value) => {
  if (typeof value !== 'string' || !value.length || value.length > 160 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('admin_response_invalid');
  return value;
};
const adminTime = (value, nullable = false) => nullable && value === null ? null : integer(value, 0, 8640000000000000);
const adminBoolean = (value) => { if (typeof value !== 'boolean') fail('admin_response_invalid'); return value; };
function adminRows(value, maximum, consume) {
  const result = rows(value, maximum).map((row) => consume(object(row)));
  if (new Set(result.map((row) => row.id)).size !== result.length) fail('duplicate_id');
  return result;
}
function adminUserSummary(value) {
  object(value);
  const status = adminChoice(value.status, ['active', 'deleted']);
  const result = { id: uuid(value.id), name: adminString(value.name, 240, true),
    identity_state: adminChoice(value.identity_state, ['anonymous', 'registered_face']),
    matching_status: adminChoice(value.matching_status, ['active', 'paused', 'absent', null]),
    status, roles: status === 'deleted' && Array.isArray(value.roles) && value.roles.length === 0 ? [] : roles(value.roles), created_at: adminTime(value.created_at) };
  if (status !== 'deleted' && result.identity_state === 'anonymous' && JSON.stringify(result.roles) !== '["user"]') fail('admin_response_invalid');
  for (const key of ['active_sessions', 'open_support', 'open_reports', 'pending_privacy']) result[key] = integer(value[key]);
  return result;
}
function adminUserDetail(value, accountId) {
  const user = adminUserSummary(value.user);
  if (user.id !== accountId) fail('account_scope_invalid');
  const sessions = adminRows(value.sessions, 50, (row) => ({ id: uuid(row.id),
    auth_method: adminChoice(row.auth_method, ['anonymous', 'registered_face']), created_at: adminTime(row.created_at), expires_at: adminTime(row.expires_at),
    status: adminChoice(row.status, ['active', 'refreshable', 'expired', 'revoked']) }));
  object(value.cases); object(value.limits); object(value.has_more);
  const cases = {
    support: adminRows(value.cases.support, 20, (row) => ({ id: uuid(row.id), subject: adminSupportSubject(row.subject),
      status: adminChoice(row.status, ['open', 'under_review', 'resolved', 'closed']), category: adminString(row.category, 100),
      created_at: adminTime(row.created_at), updated_at: adminTime(row.updated_at) })),
    safety: adminRows(value.cases.safety, 20, (row) => ({ id: uuid(row.id), status: adminChoice(row.status, ['open', 'under_review', 'resolved', 'rejected']),
      outcome: row.outcome === null ? null : adminString(row.outcome, 100), created_at: adminTime(row.created_at), reviewed_at: adminTime(row.reviewed_at, true),
      relation: adminChoice(row.relation, ['reporter', 'subject', 'reporter_and_subject']) })),
    privacy: adminRows(value.cases.privacy, 20, (row) => ({ id: uuid(row.id), request_type: adminChoice(row.request_type, ['export', 'delete']),
      status: adminString(row.status, 48), created_at: adminTime(row.created_at), reviewed_at: adminTime(row.reviewed_at, true), completed_at: adminTime(row.completed_at, true),
      failure_code: row.failure_code === null ? null : adminString(row.failure_code, 128) })),
  };
  const history = adminRows(value.history, 30, (row) => ({ id: uuid(row.id), action: adminString(row.action, 128), created_at: adminTime(row.created_at) }));
  const limits = { sessions: integer(value.limits.sessions, 50, 50), cases_per_kind: integer(value.limits.cases_per_kind, 20, 20), history: integer(value.limits.history, 30, 30) };
  const has_more = Object.fromEntries(['sessions', 'support', 'safety', 'privacy', 'history'].map((key) => [key, adminBoolean(value.has_more[key])]));
  return freeze({ user, sessions, cases, history, limits, has_more });
}

/**
 * Native-independent Fetch seam. Credentials stay private and in memory.
 * Server authorization remains authoritative; no local role or match grants access.
 */
export class LoveliesBackendClient {
  #base; #apiPrefix; #mediaOrigin; #fetch; #timeout; #jsonLimit; #previewLimit; #now; #prepared;
  #credentials = null; #epoch = 0; #requests = new Set(); #busy = false;
  #snapshots = new Map(); #previews = new Map(); #operations = new Map();
  #faceChallenges = new Map();

  /** @param {ClientOptions} options */
  constructor({ baseUrl, mediaOrigin, fetch = globalThis.fetch, timeoutMs = 20000, maxJsonBytes = 2 * 1024 * 1024, maxPreviewBytes = 4 * 1024 * 1024, now = Date.now, onOperationPrepared } = {}) {
    const location = apiLocation(baseUrl);
    this.#base = location.origin; this.#apiPrefix = location.prefix;
    this.#mediaOrigin = origin(mediaOrigin ?? location.origin);
    if (typeof fetch !== 'function' || typeof now !== 'function' || (onOperationPrepared != null && typeof onOperationPrepared !== 'function')) fail('invalid_client_options');
    this.#fetch = fetch; this.#now = now; this.#prepared = onOperationPrepared;
    this.#timeout = integer(timeoutMs, 1, 60000);
    this.#jsonLimit = integer(maxJsonBytes, 1, 2 * 1024 * 1024);
    this.#previewLimit = integer(maxPreviewBytes, 1, 4 * 1024 * 1024);
  }

  /** @returns {Readonly<SessionSummary>|null} No bearer or refresh tokens. */
  get session() {
    const value = this.#credentials;
    return value ? freeze({ accountId: value.accountId, roles: [...value.roles], authMethod: value.authMethod, authenticated: value.authMethod === 'registered_face', expiresAt: value.expiresAt, appReview: value.appReview, epoch: this.#epoch }) : null;
  }
  /** @returns {Readonly<OperationIntent>[]} Caller may persist token-free intents. */
  get pendingOperations() {
    return [...this.#operations.values()].filter((item) => item.pending).map((item) => this.#intent(item));
  }
  #intent(record) {
    return freeze({ accountId: record.accountId, source: record.source, action: record.action, operationKey: record.key, payload: copy(record.payload) });
  }
  #scope(allowExpired = false, allowAnonymous = false) {
    if (!this.#credentials) fail('authentication_required');
    if (!allowExpired && this.#credentials.expiresAt <= this.#now()) fail('session_expired');
    if (!allowAnonymous && this.#credentials.authMethod !== 'registered_face') fail('registered_face_required');
    return { epoch: this.#epoch, accountId: this.#credentials.accountId, token: this.#credentials.token };
  }
  #adminScope() {
    const scope = this.#scope();
    if (!this.#credentials.roles.includes('admin')) fail('admin_required');
    return scope;
  }
  #assert(scope) {
    if (scope.epoch !== this.#epoch || (scope.accountId != null && (scope.accountId !== this.#credentials?.accountId || scope.token !== this.#credentials?.token))) fail('session_changed');
  }
  #abortReads() { for (const controller of this.#requests) controller.abort(); }
  /** Local logout/account boundary; callers must retire already displayed media. */
  clearSession() {
    this.#epoch += 1; this.#credentials = null; this.#abortReads();
    this.#snapshots.clear(); this.#previews.clear(); this.#operations.clear(); this.#faceChallenges.clear(); this.#busy = false;
  }

  async #request(path, { method = 'GET', body, rawBody, headers = {}, scope, token = scope?.token, binary = false, absolute = false } = {}) {
    const url = absolute ? new URL(path) : new URL(`${this.#apiPrefix}${path}`, this.#base);
    if (url.origin !== (absolute ? this.#mediaOrigin : this.#base)) fail('request_origin_invalid');
    const captured = scope ?? { epoch: this.#epoch };
    this.#assert(captured);
    const controller = new AbortController(); this.#requests.add(controller);
    let timer, response, authenticationDenied = false, chunks = [], readCount = 0;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new LoveliesClientError('request_timeout', { status: 408 })); }, this.#timeout);
    });
    const race = (promise) => Promise.race([promise, deadline]);
    try {
      response = await race(this.#fetch(url.href, {
        method, headers: { accept: binary ? 'image/*' : 'application/json', ...headers, ...(body == null ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body == null ? rawBody == null ? {} : { body: rawBody } : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }));
      this.#assert(captured);
      if (!(response instanceof Response) || response.redirected || response.type === 'opaqueredirect') fail('response_invalid');
      const limit = binary ? this.#previewLimit : this.#jsonLimit;
      const contentLength = response.headers.get('content-length');
      if (contentLength != null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) fail('response_too_large');
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await race(reader.read()); this.#assert(captured);
            if (next.done) break;
            readCount += next.value.byteLength;
            if (readCount > limit) fail('response_too_large');
            chunks.push(next.value);
          }
        } finally { if (readCount > limit || controller.signal.aborted) void reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      this.#assert(captured);
      const bytes = new Uint8Array(readCount); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!response.ok) {
        let code = `http_${response.status}`;
        try {
          const problem = JSON.parse(new TextDecoder().decode(bytes));
          const supplied = problem.error?.code ?? problem.code;
          if (typeof supplied === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(supplied)) code = supplied;
        } catch { /* Never expose response text, headers, URLs or credentials. */ }
        bytes.fill(0);
        if (response.status === 401 && captured.accountId != null) { authenticationDenied = true; this.clearSession(); }
        throw new LoveliesClientError(code, { status: response.status });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (binary) {
        if (!/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(contentType) || !bytes.length) { bytes.fill(0); fail('preview_response_invalid'); }
        return { bytes, contentType };
      }
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(contentType)) fail('response_invalid');
      let decoded;
      try { decoded = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('response_invalid'); }
      return object(decoded);
    } catch (error) {
      if (authenticationDenied) throw error;
      this.#assert(captured);
      if (response && !response.ok) {
        if (response.status === 401 && captured.accountId != null) this.clearSession();
        throw new LoveliesClientError(error instanceof LoveliesClientError && error.status === response.status ? error.code : `http_${response.status}`, { status: response.status });
      }
      if (error instanceof LoveliesClientError) throw error;
      throw new LoveliesClientError('network_unavailable');
    } finally {
      clearTimeout(timer); controller.abort(); this.#requests.delete(controller);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      chunks.forEach((chunk) => chunk.fill(0)); chunks = [];
    }
  }
  async #community(action, payload, scope = this.#scope()) {
    return this.#request('/community/action', { method: 'POST', body: { action, payload }, scope });
  }

  /** Account bootstrap only. It grants no gallery, media or sharing authority. */
  async startAnonymous() {
    this.clearSession(); const scope = { epoch: this.#epoch };
    const result = await this.#request('/auth/anonymous', { method: 'POST', body: {}, scope });
    const next = credentials(result, this.#now());
    if (next.authMethod !== 'anonymous') fail('auth_response_invalid');
    this.#assert(scope); this.#credentials = next;
    return this.session;
  }
  /** The current account endpoint is GET /me. */
  async current() {
    const scope = this.#scope(false, true), result = await this.#request('/me', { scope });
    const method = this.#credentials.authMethod;
    if (uuid(result.user_id) !== scope.accountId || result.auth_method !== method || result.authenticated !== (method === 'registered_face') || result.profile_scope !== (method === 'registered_face' ? 'registered_face_profile' : 'anonymous_enrollment')) fail('account_scope_invalid');
    this.#credentials.roles = roles(result.roles);
    return freeze(copy(result));
  }
  async refresh() {
    const scope = this.#scope(true, true), refreshToken = this.#credentials.refreshToken;
    const result = await this.#request('/auth/session/refresh', { method: 'POST', scope, body: refreshToken ? { refresh_token: refreshToken } : undefined });
    const next = credentials(result, this.#now());
    if (next.accountId !== scope.accountId || next.authMethod !== this.#credentials.authMethod) { this.clearSession(); fail('account_scope_invalid'); }
    this.#assert(scope); this.#abortReads(); this.#credentials = next;
    return this.session;
  }
  /** @param {{devicePublicJwk:JsonWebKey,policyVersion:string}} input */
  async startFaceRegistration({ devicePublicJwk, policyVersion }) {
    const scope = this.#scope(false, true);
    const result = await this.#request('/auth/face/registration/challenge', { method: 'POST', scope,
      body: { device_public_jwk: publicDeviceKey(devicePublicJwk), consent: { purpose: 'face_authentication', policy_version: text(policyVersion, 128), granted: true } } });
    const challenge = faceChallenge(result, { purpose: 'registration', accountId: scope.accountId }, this.#now());
    if (challenge.policy_version !== policyVersion) fail('face_policy_mismatch');
    this.#faceChallenges.set(challenge.challenge_id, { handle: challenge, scope, captures: new Map(), uploading: new Set(), faceHandle: challenge.face_handle });
    return challenge;
  }
  /** Starts one-to-one fresh-camera verification. Possession of a handle grants no access. */
  async startFaceLogin({ faceHandle, deviceId, accountId }) {
    if (typeof faceHandle !== 'string' || !/^lfh_[A-Za-z0-9_-]{43}$/.test(faceHandle)) fail('face_handle_invalid');
    uuid(deviceId); if (accountId != null) uuid(accountId);
    this.clearSession(); const scope = { epoch: this.#epoch };
    const result = await this.#request('/auth/face/challenge', { method: 'POST', scope, body: { face_handle: faceHandle, device_id: deviceId } });
    const challenge = faceChallenge(result, { purpose: 'login', accountId, deviceId }, this.#now());
    this.#faceChallenges.set(challenge.challenge_id, { handle: challenge, scope, captures: new Map(), uploading: new Set(), faceHandle });
    return challenge;
  }
  #faceEntry(challenge) {
    const entry = challenge && this.#faceChallenges.get(challenge.challenge_id);
    if (!entry || entry.handle !== challenge) fail('face_challenge_context_required');
    this.#assert(entry.scope); expiry(challenge.expires_at, this.#now());
    return entry;
  }
  /** Caller supplies real camera bytes and its private-device P256 signing adapter. */
  async uploadFaceCapture(challenge, { bytes, mime, index, sign }) {
    const entry = this.#faceEntry(challenge);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_FACE_CAPTURE_BYTES || typeof sign !== 'function') fail('face_capture_invalid');
    integer(index, 0, challenge.required_captures - 1);
    if (entry.captures.has(index) || entry.uploading.has(index) || entry.uploading.size) fail('face_capture_in_progress');
    if ([...entry.captures.values()].reduce((sum, item) => sum + item.byte_size, 0) + bytes.length > MAX_FACE_CAPTURE_BYTES) fail('face_capture_too_large');
    entry.uploading.add(index); const owned = new Uint8Array(bytes);
    try {
      const sha256 = await faceCaptureDigest(owned); this.#assert(entry.scope);
      if ([...entry.captures.values()].some(item => item.sha256 === sha256)) fail('face_capture_reused');
      const payload = faceCapturePayload(challenge, { index, sha256, mime, byteSize: owned.length });
      const signature = deviceSignature(await sign(faceSigningBytes(payload))); this.#assert(entry.scope);
      const result = await this.#request(`/auth/face/proof/${challenge.challenge_id}/${index}`, {
        method: 'PUT', scope: entry.scope, rawBody: owned,
        headers: { 'content-type': mime, 'x-lovelies-capture-sha256': sha256,
          'x-lovelies-capture-bytes': String(owned.length), 'x-lovelies-device-signature': signature } });
      if (result.protocol !== FACE_PROTOCOL || result.status !== 'capture_received' || result.challenge_id !== challenge.challenge_id || result.capture_index !== index || result.capture_sha256 !== sha256 || result.byte_size !== owned.length) fail('face_capture_response_invalid');
      entry.captures.set(index, { index, sha256, mime, byte_size: owned.length });
      return freeze(copy(result));
    } finally { owned.fill(0); entry.uploading.delete(index); }
  }
  async #completeFace(challenge, sign, purpose) {
    const entry = this.#faceEntry(challenge);
    if (challenge.purpose !== purpose || typeof sign !== 'function' || entry.uploading.size) fail('face_challenge_invalid');
    const captures = [...entry.captures.values()].sort((left, right) => left.index - right.index);
    const payload = faceCompletionPayload(challenge, captures);
    const signature = deviceSignature(await sign(faceSigningBytes(payload))); this.#assert(entry.scope);
    const result = await this.#request(purpose === 'registration' ? '/auth/face/registration/complete' : '/auth/face/complete', {
      method: 'POST', scope: entry.scope, body: { challenge_id: challenge.challenge_id, device_signature: signature } });
    if (result.protocol !== FACE_PROTOCOL || result.status !== 'authenticated' || result.device_id !== challenge.device_id) fail('face_auth_response_invalid');
    const next = credentials(result, this.#now());
    if (next.authMethod !== 'registered_face' || next.accountId !== challenge.account_id) fail('account_scope_invalid');
    uuid(result.profile_id); text(result.profile_revision, 128); text(result.model_id, 128);
    if (challenge.profile_id !== null && (result.profile_id !== challenge.profile_id || result.profile_revision !== challenge.profile_revision || result.model_id !== challenge.model_id)) fail('registered_reference_changed');
    this.#assert(entry.scope);
    this.#epoch += 1; this.#abortReads(); this.#credentials = next;
    this.#snapshots.clear(); this.#previews.clear(); this.#operations.clear(); this.#faceChallenges.clear();
    return freeze({ session: this.session, registeredFace: { accountId: next.accountId, faceHandle: entry.faceHandle,
      deviceId: result.device_id, profileId: result.profile_id, profileRevision: result.profile_revision, modelId: result.model_id } });
  }
  async completeFaceRegistration(challenge, { sign }) { return this.#completeFace(challenge, sign, 'registration'); }
  async completeFaceLogin(challenge, { sign }) { return this.#completeFace(challenge, sign, 'login'); }
  async logout() {
    const previous = this.#credentials;
    this.clearSession();
    if (!previous) return;
    // Clear locally before waiting, even when revocation cannot reach the server.
    await this.#request('/auth/logout', { method: 'POST', scope: { epoch: this.#epoch }, token: previous.token, body: previous.refreshToken ? { refresh_token: previous.refreshToken } : undefined });
  }
  /** Read bounded account metadata. Backend authorization remains authoritative.
   * @param {{query?:string,status?:'all'|'registered'|'anonymous'|'deleted',limit?:number,cursor?:string}} options
   * @returns {Promise<Readonly<AdminUserPage>>} */
  async adminUsers({ query = '', status = 'all', limit = 25, cursor } = {}) {
    const scope = this.#adminScope();
    if (typeof query !== 'string' || query.length > 100 || /[\x00-\x1f\x7f]/.test(query) || !['all', 'registered', 'anonymous', 'deleted'].includes(status)) fail('invalid_admin_query');
    integer(limit, 1, 100);
    const params = new URLSearchParams({ q: query, status, limit: String(limit) });
    if (cursor != null) params.set('cursor', text(cursor, 2048));
    const value = await this.#request(`/admin/users?${params}`, { scope });
    const users = adminRows(value.users, limit, adminUserSummary), page = object(value.page);
    integer(page.limit, limit, limit); const hasMore = adminBoolean(page.has_more);
    const nextCursor = page.next_cursor === null ? null : text(page.next_cursor, 2048);
    if (hasMore !== (nextCursor !== null)) fail('admin_response_invalid');
    if (status !== 'all' && users.some((user) => status === 'deleted' ? user.status !== 'deleted' : user.status !== 'active' ||
        (status === 'registered' && user.identity_state !== 'registered_face') || (status === 'anonymous' && user.identity_state !== 'anonymous'))) fail('admin_response_invalid');
    return freeze({ users, page: { limit, has_more: hasMore, next_cursor: nextCursor } });
  }
  /** @param {string} accountId @returns {Promise<Readonly<AdminUserDetail>>} */
  async adminUser(accountId) {
    const scope = this.#adminScope(), id = uuid(accountId);
    const value = await this.#request(`/admin/users/${id}`, { scope });
    return adminUserDetail(value, id);
  }
  /** Keep the original key/reason for an explicit retry after an ambiguous reply.
   * The server rechecks current admin authority and fresh face verification on every attempt. */
  async revokeAdminUserSession(accountId, sessionId, { reason, operationKey: suppliedKey } = {}) {
    const scope = this.#adminScope(), account = uuid(accountId), session = uuid(sessionId), key = operationKey(suppliedKey);
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) fail('invalid_operation_key');
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) fail('invalid_admin_reason');
    try {
      const value = await this.#request(`/admin/users/${account}/sessions/revoke`, { method: 'POST', scope,
        body: { session_id: session, reason: reason.trim(), operation_key: key } });
      if (uuid(value.account_id) !== account || uuid(value.session_id) !== session || value.status !== 'revoked' || value.account_disabled !== false) fail('admin_response_invalid');
      return freeze({ account_id: account, session_id: session, status: 'revoked', sessions_revoked: integer(value.sessions_revoked, 0, 1), account_disabled: false });
    } catch (error) {
      const definite = error instanceof LoveliesClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (definite || error?.code === 'session_changed') throw error;
      throw new LoveliesClientError(error instanceof LoveliesClientError ? error.code : 'operation_unconfirmed', { status: error?.status ?? 0, operationKey: key, ambiguous: true });
    }
  }
  async gallery() {
    const result = await this.#request('/me/gallery', { scope: this.#scope() });
    const capabilities = object(result.capabilities);
    for (const key of ['view_matched_photos', 'download_photos']) if (typeof capabilities[key] !== 'boolean') fail('gallery_response_invalid');
    const items = metadata(result.gallery_items ?? result.items, true);
    return freeze({ ...copy(result), ...(result.gallery_items ? { gallery_items: items } : { items }) });
  }
  async photos({ source: photoSource = 'received', limit = 30, cursor, query } = {}) {
    if (!['received', 'contributions', 'all'].includes(photoSource)) fail('invalid_photo_source');
    const payload = { source: photoSource, limit: integer(limit, 1, 100) };
    if (cursor) { object(cursor); text(cursor.before_at, 64); uuid(cursor.before_id); payload.before_at = cursor.before_at; payload.before_id = cursor.before_id; }
    if (query != null) { if (typeof query !== 'string' || query.length > 500) fail('invalid_query'); payload.query = query; }
    const result = await this.#community('photos', payload), items = metadata(result.items);
    if (photoSource !== 'all' && items.some((item) => item.source !== photoSource)) fail('photo_scope_invalid');
    if (result.next_cursor != null) { object(result.next_cursor); text(result.next_cursor.before_at, 64); uuid(result.next_cursor.before_id); }
    return freeze({ ...copy(result), items });
  }
  async preview(assetId, { professional = false } = {}) {
    if (professional !== false) fail('invalid_source');
    const id = uuid(assetId), scope = this.#scope();
    const allowed = await this.#community('photos.validate', { asset_ids: [id] }, scope);
    const authorized = ids(allowed.authorized_ids);
    if (authorized.some((item) => item !== id) || !authorized.includes(id)) fail('preview_access_unverified');
    const result = await this.#request(`/community/media/${id}/preview`, { scope, binary: true });
    return { ...result, epoch: scope.epoch, accountId: scope.accountId, assetId: id };
  }
  async galleryPreview(assetId) {
    const id = uuid(assetId), scope = this.#scope();
    const grant = await this.#request('/previews/sign', { method: 'POST', body: { asset_id: id }, scope });
    const signed = new URL(text(grant.preview_url ?? grant.url, 8192));
    const previewPath = this.#apiPrefix ? signed.pathname.slice(this.#apiPrefix.length) : signed.pathname;
    if (signed.origin !== this.#mediaOrigin || signed.username || signed.password || signed.hash || signed.search ||
        (this.#apiPrefix && !signed.pathname.startsWith(`${this.#apiPrefix}/`)) || !/^\/previews\/[A-Za-z0-9._-]+$/.test(previewPath)) fail('preview_origin_invalid');
    const expiresAt = Math.min(this.#now() + integer(grant.expires_in, 1, 3600) * 1000, this.#credentials.expiresAt);
    const result = await this.#request(signed.href, { scope, token: null, binary: true, absolute: true });
    if (expiresAt <= this.#now()) { result.bytes.fill(0); fail('preview_expired'); }
    return { ...result, epoch: scope.epoch, accountId: scope.accountId, assetId: id, expiresAt };
  }

  #registered(handle, map) {
    const entry = handle && map.get(handle.id);
    if (!entry || entry.handle !== handle || entry.accountId !== this.#scope().accountId || entry.epoch !== this.#epoch) fail('review_handle_invalid');
    expiry(handle.expires_at, this.#now());
    return entry;
  }
  async snapshot({ assetIds, uploadBatchId, source: requestedSource = 'personal', operationKey: key }) {
    source(requestedSource); const selected = assetIds == null ? undefined : ids(assetIds);
    if (selected && !selected.length) fail('invalid_selection');
    const batch = uploadBatchId == null ? undefined : uuid(uploadBatchId);
    const requested = { source: requestedSource, assetIds: selected, uploadBatchId: batch };
    const payload = { ...(selected ? { asset_ids: selected } : {}), ...(batch ? { upload_batch_id: batch } : {}) };
    return this.#mutate('sharing.snapshot', payload, key, { source: requestedSource, requested });
  }
  /** @param {object} snapshot @param {import('./contracts.mjs').ShareDraft} draft */
  async preparePreview(snapshot, draft, { operationKey: key }) {
    const entry = this.#registered(snapshot, this.#snapshots), payload = previewPayload(snapshot, draft);
    for (const [id, item] of this.#previews) if (item.snapshot.id === snapshot.id) this.#previews.delete(id);
    return this.#mutate('sharing.preview', payload, key, { source: entry.source, snapshot, draft: copy(draft) });
  }
  async commit(preview, { draft, operationKey: key }) {
    const entry = this.#registered(preview, this.#previews);
    this.#registered(entry.snapshot, this.#snapshots);
    if (draft?.version !== preview.draft_version || !samePairs(effectiveSelection(entry.snapshot, draft), preview.pairs)) fail('review_selection_changed');
    return this.#mutate('sharing.commit', { preview_id: preview.id, preview_version: preview.version, draft_version: preview.draft_version }, key, { source: entry.source, approved: preview });
  }
  async receipt(requestId, { source: expectedSource = 'personal' } = {}) {
    const id = uuid(requestId); source(expectedSource);
    return receiptResponse(await this.#community('receipt', { request_id: id }), id, expectedSource);
  }
  async decideRequest(requestId, decision, { operationKey: key, source: expectedSource = 'personal' }) {
    const id = uuid(requestId); source(expectedSource);
    if (!['accept', 'decline', 'withdraw', 'revoke'].includes(decision)) fail('invalid_decision');
    return this.#mutate('request.decide', { request_id: id, decision }, key, { source: expectedSource });
  }

  async #mutate(action, payload, suppliedKey, context) {
    const scope = this.#scope(), key = operationKey(suppliedKey);
    if (this.#busy || this.pendingOperations.length) fail('reconcile_required');
    const previous = this.#operations.get(key);
    if (previous) fail('operation_key_already_used');
    if (this.#operations.size >= 200) fail('operation_capacity_reached');
    const record = { key, action, payload: freeze(copy(payload)), accountId: scope.accountId, epoch: scope.epoch, ...context, pending: true, result: null };
    this.#operations.set(key, record);
    return this.#dispatch(record);
  }
  async #dispatch(record) {
    if (this.#busy) fail('reconcile_required');
    const scope = this.#scope(); this.#busy = true;
    try {
      if (record.accountId !== scope.accountId || record.epoch !== scope.epoch) fail('operation_scope_invalid');
      if (this.#prepared) { await this.#prepared(this.#intent(record)); this.#assert(scope); }
      const result = await this.#community(record.action, { ...record.payload, operation_key: record.key }, scope);
      return this.#consume(record, result);
    } catch (error) {
      if (this.#epoch === scope.epoch && record.accountId === this.#credentials?.accountId) {
        const definite = error instanceof LoveliesClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        if (definite) record.pending = false;
        if (!definite) throw new LoveliesClientError(error instanceof LoveliesClientError ? error.code : 'operation_unconfirmed', { status: error?.status ?? 0, operationKey: record.key, ambiguous: true });
      }
      throw error;
    } finally { if (this.#epoch === scope.epoch) this.#busy = false; }
  }
  #consume(record, result) {
    let value;
    if (record.action === 'sharing.snapshot') {
      value = snapshotResponse(result, record.requested, this.#now());
      this.#snapshots.set(value.id, { handle: value, source: record.source, accountId: record.accountId, epoch: record.epoch });
    } else if (record.action === 'sharing.preview') {
      value = previewResponse(result, record.snapshot, record.draft, this.#now());
      if (value.status === 'ready') {
        value = value.preview;
        this.#previews.set(value.id, { handle: value, snapshot: record.snapshot, source: record.source, accountId: record.accountId, epoch: record.epoch });
      }
    } else if (record.action === 'sharing.commit') {
      value = shareOutcome(result, record.source, record.key, record.approved);
      if (value.status === 'changed') this.#previews.delete(record.approved.id);
    } else value = decisionResponse(result, record.payload.request_id, record.payload.decision, record.source);
    record.result = value; record.pending = false;
    return value;
  }
  /** Read current server outcome. Unknown is not a confirmed failed mutation. */
  async operation(key, { source: expectedSource = 'personal' } = {}) {
    operationKey(key); source(expectedSource);
    const scope = this.#scope(), record = this.#operations.get(key);
    if (record && record.source !== expectedSource) fail('source_mismatch');
    const value = await this.#community('operation', { operation_key: key }, scope);
    if (value.status === 'unknown' && Object.keys(value).length === 1) return freeze({ status: 'unknown' });
    return record ? this.#consume(record, value) : shareOutcome(value, expectedSource, key);
  }
  async reconcile(key) {
    const record = this.#operations.get(operationKey(key));
    if (!record) fail('operation_context_required');
    return this.operation(key, { source: record.source });
  }
  /** Reconcile first; only an explicit unknown may replay the original payload/key. */
  async retry(key) {
    const record = this.#operations.get(operationKey(key));
    if (!record) fail('operation_context_required');
    if (this.#busy) fail('reconcile_required');
    const wasPending = record.pending, value = await this.reconcile(key);
    if (value.status !== 'unknown' || !wasPending) return value;
    return this.#dispatch(record);
  }
}
