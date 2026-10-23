import {
  LoveliesClientError, fail, object, text, uuid, integer, rows, ids, operationKey,
  source, checkSource, expiry, freeze, copy, roles, credentials, samePairs,
  effectiveSelection, previewPayload, snapshotResponse, previewResponse,
  shareOutcome, receiptResponse, decisionResponse,
} from './contracts.mjs';

export { LoveliesClientError, effectiveSelection } from './contracts.mjs';

/**
 * @typedef {{accountId:string,roles:string[],expiresAt:number,appReview:boolean,epoch:number}} SessionSummary
 * @typedef {{accountId:string,source:'personal'|'professional',action:string,operationKey:string,payload:object}} OperationIntent
 * @typedef {{baseUrl:string,mediaOrigin?:string,fetch?:typeof globalThis.fetch,timeoutMs?:number,maxJsonBytes?:number,maxPreviewBytes?:number,now?:()=>number,onOperationPrepared?:(intent:OperationIntent)=>Promise<void>|void}} ClientOptions
 */

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_api_origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('invalid_api_origin');
  return url.origin;
}
function metadata(rowsValue, gallery = false) {
  const seen = new Set();
  return rows(rowsValue, 100).map((item) => {
    object(item); const id = uuid(item.id);
    if (seen.has(id)) fail('duplicate_id');
    seen.add(id);
    if (gallery) { uuid(item.media_asset_id); uuid(item.match_id); text(item.visibility); }
    else if (!['received', 'contributions'].includes(item.source)) fail('photo_scope_invalid');
    for (const key of ['width', 'height']) if (item[key] != null) integer(item[key], 1, 100000);
    if (item.orientation != null) integer(item.orientation, 1, 8);
    return copy(item);
  });
}

/**
 * Native-independent Fetch seam. Credentials stay private and in memory.
 * Server authorization remains authoritative; no local role or match grants access.
 */
export class LoveliesBackendClient {
  #base; #mediaOrigin; #fetch; #timeout; #jsonLimit; #previewLimit; #now; #prepared;
  #credentials = null; #epoch = 0; #requests = new Set(); #busy = false;
  #snapshots = new Map(); #previews = new Map(); #operations = new Map();

  /** @param {ClientOptions} options */
  constructor({ baseUrl, mediaOrigin = baseUrl, fetch = globalThis.fetch, timeoutMs = 20000, maxJsonBytes = 2 * 1024 * 1024, maxPreviewBytes = 4 * 1024 * 1024, now = Date.now, onOperationPrepared } = {}) {
    this.#base = origin(baseUrl); this.#mediaOrigin = origin(mediaOrigin);
    if (typeof fetch !== 'function' || typeof now !== 'function' || (onOperationPrepared != null && typeof onOperationPrepared !== 'function')) fail('invalid_client_options');
    this.#fetch = fetch; this.#now = now; this.#prepared = onOperationPrepared;
    this.#timeout = integer(timeoutMs, 1, 60000);
    this.#jsonLimit = integer(maxJsonBytes, 1, 2 * 1024 * 1024);
    this.#previewLimit = integer(maxPreviewBytes, 1, 4 * 1024 * 1024);
  }

  /** @returns {Readonly<SessionSummary>|null} No bearer or refresh tokens. */
  get session() {
    const value = this.#credentials;
    return value ? freeze({ accountId: value.accountId, roles: [...value.roles], expiresAt: value.expiresAt, appReview: value.appReview, epoch: this.#epoch }) : null;
  }
  /** @returns {Readonly<OperationIntent>[]} Caller may persist token-free intents. */
  get pendingOperations() {
    return [...this.#operations.values()].filter((item) => item.pending).map((item) => this.#intent(item));
  }
  #intent(record) {
    return freeze({ accountId: record.accountId, source: record.source, action: record.action, operationKey: record.key, payload: copy(record.payload) });
  }
  #scope(allowExpired = false) {
    if (!this.#credentials) fail('authentication_required');
    if (!allowExpired && this.#credentials.expiresAt <= this.#now()) fail('session_expired');
    return { epoch: this.#epoch, accountId: this.#credentials.accountId, token: this.#credentials.token };
  }
  #assert(scope) {
    if (scope.epoch !== this.#epoch || (scope.accountId != null && (scope.accountId !== this.#credentials?.accountId || scope.token !== this.#credentials?.token))) fail('session_changed');
  }
  #abortReads() { for (const controller of this.#requests) controller.abort(); }
  /** Local logout/account boundary; callers must retire already displayed media. */
  clearSession() {
    this.#epoch += 1; this.#credentials = null; this.#abortReads();
    this.#snapshots.clear(); this.#previews.clear(); this.#operations.clear(); this.#busy = false;
  }

  async #request(path, { method = 'GET', body, scope, token = scope?.token, binary = false, absolute = false } = {}) {
    const url = absolute ? new URL(path) : new URL(path, this.#base);
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
        method, headers: { accept: binary ? 'image/*' : 'application/json', ...(body == null ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
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

  async startOtp({ phone, requestedRole = 'user' }) {
    text(phone, 32); if (!/^\+?[0-9]{7,15}$/.test(phone)) fail('invalid_phone');
    roles([requestedRole]);
    const result = await this.#request('/auth/otp/start', { method: 'POST', body: { phone, requested_role: requestedRole } });
    text(result.status); text(result.provider);
    if (typeof result.message !== 'string') fail('auth_response_invalid');
    return freeze(copy(result));
  }
  async verifyOtp({ phone, code, requestedRole = 'user' }) {
    text(phone, 32); text(code, 12); roles([requestedRole]);
    if (!/^\+?[0-9]{7,15}$/.test(phone) || !/^[0-9]{4,8}$/.test(code)) fail('invalid_otp');
    this.clearSession(); const scope = { epoch: this.#epoch };
    const result = await this.#request('/auth/otp/verify', { method: 'POST', body: { phone, code, requested_role: requestedRole }, scope });
    this.#assert(scope); this.#credentials = credentials(result, this.#now());
    return this.session;
  }
  /** Actual donor route is GET /me, not an invented /auth/current endpoint. */
  async current() {
    const scope = this.#scope(), result = await this.#request('/me', { scope });
    if (uuid(result.user_id) !== scope.accountId || result.profile_scope !== 'registered_face_profile') fail('account_scope_invalid');
    this.#credentials.roles = roles(result.roles);
    return freeze(copy(result));
  }
  async refresh() {
    const scope = this.#scope(true), refreshToken = this.#credentials.refreshToken;
    const result = await this.#request('/auth/session/refresh', { method: 'POST', scope, body: refreshToken ? { refresh_token: refreshToken } : undefined });
    const next = credentials(result, this.#now());
    if (next.accountId !== scope.accountId) { this.clearSession(); fail('account_scope_invalid'); }
    this.#assert(scope); this.#abortReads(); this.#credentials = next;
    return this.session;
  }
  async logout() {
    const previous = this.#credentials;
    this.clearSession();
    if (!previous) return;
    // Clear locally before waiting, even when revocation cannot reach the server.
    await this.#request('/auth/logout', { method: 'POST', scope: { epoch: this.#epoch }, token: previous.token, body: previous.refreshToken ? { refresh_token: previous.refreshToken } : undefined });
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
    const id = uuid(assetId), scope = this.#scope();
    if (typeof professional !== 'boolean') fail('invalid_source');
    const allowed = await this.#community(professional ? 'sharing.photos.validate' : 'photos.validate', { ...(professional ? { source: 'professional' } : {}), asset_ids: [id] }, scope);
    const authorized = ids(allowed.authorized_ids);
    if (authorized.some((item) => item !== id) || !authorized.includes(id)) fail('preview_access_unverified');
    const result = await this.#request(`/community/media/${id}/preview`, { scope, binary: true });
    return { ...result, epoch: scope.epoch, accountId: scope.accountId, assetId: id };
  }
  async galleryPreview(assetId) {
    const id = uuid(assetId), scope = this.#scope();
    const grant = await this.#request('/previews/sign', { method: 'POST', body: { asset_id: id }, scope });
    const signed = new URL(text(grant.preview_url ?? grant.url, 8192));
    if (signed.origin !== this.#mediaOrigin || signed.username || signed.password || signed.hash || signed.search || !/^\/previews\/[A-Za-z0-9._-]+$/.test(signed.pathname)) fail('preview_origin_invalid');
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
    if (requestedSource === 'professional' && !batch && !selected?.length) fail('owned_source_required');
    const requested = { source: requestedSource, assetIds: selected, uploadBatchId: batch };
    const payload = { ...(requestedSource === 'professional' ? { source: 'professional' } : {}), ...(selected ? { asset_ids: selected } : {}), ...(batch ? { upload_batch_id: batch } : {}) };
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
