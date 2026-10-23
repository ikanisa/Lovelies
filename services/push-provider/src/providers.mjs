import { createPrivateKey, sign } from 'node:crypto';
import { connect, constants } from 'node:http2';
const json64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function signedJWT(header, claims, key, algorithm) {
  const content = json64(header) + '.' + json64(claims);
  const signature = sign('sha256', Buffer.from(content), algorithm === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return content + '.' + signature.toString('base64url');
}
export async function boundedResponse(response, limit = 8192) {
  if (response.redirected || response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('provider_redirect_refused'); }
  const reader = response.body?.getReader(); if (!reader) return '';
  let total = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) { await reader.cancel(); throw new Error('provider_response_too_large'); } chunks.push(value); } return Buffer.concat(chunks).toString('utf8'); }
  finally { reader.releaseLock(); }
}
export class ApnsAuthorization {
  constructor({ teamID, keyID, privateKey, now = Date.now }) {
    if (!/^[A-Z0-9]{10}$/.test(teamID ?? '') || !/^[A-Z0-9]{10}$/.test(keyID ?? '')) throw new Error('invalid_apns_issuer_or_key');
    this.key = createPrivateKey(privateKey);
    if (this.key.asymmetricKeyType !== 'ec' || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires an ES256 P-256 provider key');
    this.teamID = teamID; this.keyID = keyID; this.now = now;
  }
  token() {
    const now = Math.floor(this.now() / 1000);
    if (!this.cached || now < this.issuedAt || now - this.issuedAt >= 50 * 60) {
      this.cached = signedJWT({ alg: 'ES256', kid: this.keyID }, { iss: this.teamID, iat: now }, this.key, 'ES256'); this.issuedAt = now;
    }
    return this.cached;
  }
}
export class FcmAuthorization {
  constructor({ serviceAccount, projectID, fetcher = fetch, now = Date.now }) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectID ?? '') || serviceAccount?.type !== 'service_account' || serviceAccount.project_id !== projectID ||
        !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount.client_email ?? '') || serviceAccount.token_uri !== 'https://oauth2.googleapis.com/token') throw new Error('invalid_fcm_service_account');
    this.key = createPrivateKey(serviceAccount.private_key);
    if (this.key.asymmetricKeyType !== 'rsa' || this.key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('FCM requires an RSA service-account key of at least 2048 bits');
    this.email = serviceAccount.client_email; this.projectID = projectID; this.fetcher = fetcher; this.now = now;
  }
  async token() {
    if (this.cached && this.now() >= this.issuedAt && this.now() < this.expiresAt - 60_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.acquire();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async acquire() {
    const issuedAt = this.now(), iat = Math.floor(issuedAt / 1000);
    const assertion = signedJWT({ alg: 'RS256', typ: 'JWT' }, { iss: this.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, this.key, 'RS256');
    const reply = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    const text = await boundedResponse(reply), value = JSON.parse(text);
    if (reply.status !== 200 || value.token_type?.toLowerCase() !== 'bearer' || typeof value.access_token !== 'string' || !/^[a-zA-Z0-9._~+\/-]{16,8192}$/.test(value.access_token) ||
        !Number.isInteger(value.expires_in) || value.expires_in < 120 || value.expires_in > 3600) throw new Error('oauth_token_unavailable');
    this.cached = value.access_token; this.issuedAt = issuedAt; this.expiresAt = issuedAt + value.expires_in * 1000; return this.cached;
  }
}
const apnsCodes = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'BadTopic', 'TopicDisallowed', 'PayloadTooLarge', 'ExpiredProviderToken', 'InvalidProviderToken', 'TooManyProviderTokenUpdates', 'TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown', 'Forbidden', 'MissingTopic', 'BadPriority', 'BadExpirationDate']);
const fcmCodes = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH', 'INVALID_ARGUMENT', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL', 'THIRD_PARTY_AUTH_ERROR', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED']);
const ambiguous = () => ({ status: 'ambiguous', provider_code: 'dispatch_result_unconfirmed' });
export class ApnsProvider {
  constructor({ authorization, topic, environment, now = Date.now, sessionFactory = connect, timeoutMs = 15_000 }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,199}$/.test(topic ?? '') || !['production', 'sandbox'].includes(environment)) throw new Error('invalid_apns_application');
    this.authorization = authorization; this.topic = topic; this.origin = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    this.now = now; this.sessionFactory = sessionFactory; this.timeoutMs = timeoutMs; this.sessions = new Set();
  }
  async prepare(input, requestID) {
    return { requestID, headers: { ':method': 'POST', ':path': '/3/device/' + input.token, 'authorization': 'bearer ' + this.authorization.token(),
      'apns-topic': this.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-id': requestID,
      'apns-expiration': String(Math.floor(this.now() / 1000) + 86_400), 'content-type': 'application/json' },
      body: JSON.stringify({ aps: { alert: { title: 'Lovelies', body: input.notification.title }, sound: 'default' }, id: input.notification.id, kind: input.notification.kind, entity_id: input.notification.entity_id }) };
  }
  session() {
    if (this.connection && !this.connection.closed && !this.connection.destroyed) return this.connection;
    const session = this.sessionFactory(this.origin, { rejectUnauthorized: true });
    session.on('error', () => {}); // Stream errors remain observable, credentials are never logged.
    session.on('goaway', () => { if (this.connection === session) this.connection = null; session.close(); });
    session.on('close', () => this.sessions.delete(session)); this.sessions.add(session); this.connection = session; return session;
  }
  async send(prepared) {
    const reply = await new Promise((resolve, reject) => {
      const stream = this.session().request(prepared.headers); let headers, size = 0; const chunks = [];
      const timer = setTimeout(() => { stream.close(constants.NGHTTP2_CANCEL); reject(new Error('apns_timeout')); }, this.timeoutMs); timer.unref?.();
      stream.on('response', value => { headers = value; });
      stream.on('data', value => { size += value.length; if (size > 8192) { stream.close(constants.NGHTTP2_CANCEL); reject(new Error('apns_response_too_large')); } else chunks.push(Buffer.from(value)); });
      stream.on('error', error => { clearTimeout(timer); reject(error); });
      stream.on('end', () => { clearTimeout(timer); resolve({ status: Number(headers?.[':status']), id: headers?.['apns-id'], text: Buffer.concat(chunks).toString('utf8') }); });
      stream.on('close', () => { clearTimeout(timer); if (!stream.readableEnded) reject(new Error('apns_stream_closed')); });
      stream.end(prepared.body);
    });
    if (reply.status === 200) return reply.id === prepared.requestID ? { status: 'accepted', provider_message_id: reply.id } : ambiguous();
    if (!Number.isInteger(reply.status) || reply.status < 400 || reply.status > 599) return ambiguous();
    let reason; try { reason = JSON.parse(reply.text).reason; } catch {}
    const code = apnsCodes.has(reason) ? reason : 'http_' + reply.status;
    return { status: 'rejected', provider_code: 'apns.' + code, token_invalid: ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(code), retryable: [429, 500, 503].includes(reply.status) };
  }
  async close() { for (const session of this.sessions) session.destroy(); this.sessions.clear(); this.connection = null; }
}
export class FcmProvider {
  constructor({ authorization, projectID, packageName, fetcher = fetch }) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectID ?? '') || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/.test(packageName ?? '')) throw new Error('invalid_fcm_application');
    this.authorization = authorization; this.projectID = projectID; this.packageName = packageName; this.fetcher = fetcher;
  }
  async prepare(input) {
    return { url: `https://fcm.googleapis.com/v1/projects/${this.projectID}/messages:send`, token: await this.authorization.token(),
      body: JSON.stringify({ message: { token: input.token, data: { id: input.notification.id, kind: input.notification.kind, entity_id: input.notification.entity_id },
        android: { restricted_package_name: this.packageName, priority: 'NORMAL', ttl: '86400s' } } }) };
  }
  async send(prepared) {
    const reply = await this.fetcher(prepared.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + prepared.token }, body: prepared.body });
    const text = await boundedResponse(reply); let value; try { value = JSON.parse(text); } catch { return ambiguous(); }
    if (reply.status === 200) {
      const prefix = `projects/${this.projectID}/messages/`;
      return typeof value.name === 'string' && value.name.startsWith(prefix) && value.name.length > prefix.length && value.name.length <= 256 && !/[\u0000-\u001f]/.test(value.name)
        ? { status: 'accepted', provider_message_id: value.name } : ambiguous();
    }
    if (reply.status < 400 || reply.status > 599) return ambiguous();
    const fcm = Array.isArray(value.error?.details) ? value.error.details.find(x => x?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode : null;
    const code = fcmCodes.has(fcm) ? fcm : fcmCodes.has(value.error?.status) ? value.error.status : 'http_' + reply.status;
    return { status: 'rejected', provider_code: 'fcm.' + code, token_invalid: ['UNREGISTERED', 'SENDER_ID_MISMATCH'].includes(code), retryable: [429, 500, 503].includes(reply.status) };
  }
  async close() {}
}
