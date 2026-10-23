import { DurableObject } from 'cloudflare:workers';
import { SqlDatabase } from './database';
import { initSchema, currentSchemaVersion } from './schema';
import { authenticate, assertActor, handleAuth } from './auth';
import { handleFaceAuth, cleanupFaceProofs, nextFaceRecoveryAt } from './face-auth';
import { handleFaceProfile, finishLifecycleCleanup, nextLifecycleAt } from './face-profile';
import { handleSharing } from './sharing';
import { handleGallery } from './gallery';
import { handleProfile } from './profile';
import { handleIdentity } from './identity';
import { handleEntitlements } from './entitlements';
import { handleOperators } from './operators';
import { handleAdminUsers } from './admin-users';
import { handleNotifications, flushNotificationOutbox, processNotificationJob } from './notifications';
import { handleRetention, runRetention, nextRetentionAt } from './retention';
import { expireUploads, nextUploadAt } from './upload-transfers';
import { handleProcessing, processPhotoJob, flushPhotoOutbox } from './processing';
import { handlePrivacy, processPrivacyJob, flushPrivacyCleanup } from './privacy';
import { ApiError, digest, jsonBody, ok, type AppContext, type CloudflareEnv } from './types';

const authorityName = 'lovelies-core-v1';
const internalPath = '/_internal/queue';
const sensitiveHeaders = ['x-lovelies-internal', 'x-lovelies-address'];

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return ok({ error: { code: error.code } }, error.status);
  console.error('lovelies_core_failure', error instanceof Error ? error.name : 'unknown');
  return ok({ error: { code: 'internal_error' } }, 500);
}

function requiredBindings(env: CloudflareEnv): string[] {
  const missing: string[] = [];
  for (const name of ['PHOTOS', 'QUARANTINE', 'PRIVACY_EXPORTS', 'PHOTO_JOBS', 'FACE_AUTH_VERIFIER', 'PHOTO_PROCESSOR'] as const) {
    if (!env[name]) missing.push(name);
  }
  for (const name of ['AUTH_SIGNING_SECRET', 'MEDIA_SIGNING_SECRET'] as const) {
    if (!env[name] || env[name]!.length < 32) missing.push(name);
  }
  for (const name of ['FACE_AUTH_POLICY_VERSION', 'PHOTO_MODEL_VERSION'] as const) {
    if (!env[name]?.trim()) missing.push(name);
  }
  return missing;
}

/** Accounts, sessions, profiles, review, approvals and grants share one SQLite
 * authority. Each module consumes cursors synchronously and rechecks state after
 * storage/provider awaits. No PostgreSQL adapter is used in the active service. */
export class LoveliesCore extends DurableObject<CloudflareEnv> {
  private readonly app: AppContext;
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const db = new SqlDatabase(state.storage);
    this.app = {
      db, env, now: Date.now,
      authenticate: (request) => authenticate(request, this.app),
      assertActor: (actor) => assertActor(actor, this.app),
    };
    state.blockConcurrencyWhile(async () => { initSchema(db); });
  }

  private async limitPublicAuth(request: Request, lane: 'anonymous' | 'recovery' | 'profile'): Promise<void> {
    // The edge overwrites this header. Raw addresses are never persisted.
    const address = request.headers.get('x-lovelies-address') ?? 'unavailable';
    const slot = Math.floor(this.app.now() / 60_000);
    const key = await digest(`${lane}:${slot}:${address}`);
    this.app.db.transaction(() => {
      this.app.db.run('DELETE FROM request_limits WHERE expires_at<?', this.app.now());
      const limit = this.app.db.one<{ hits: number }>('SELECT hits FROM request_limits WHERE key=?', key);
      if (limit && limit.hits >= (lane === 'profile' ? 120 : 30)) throw new ApiError(429, lane === 'anonymous' ? 'anonymous_rate_limited' : lane === 'profile' ? 'face_profile_rate_limited' : 'account_recovery_rate_limited');
      this.app.db.run('INSERT INTO request_limits(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1', key, (slot + 2) * 60_000);
    });
  }

  private async scheduleMaintenance(): Promise<void> {
    const due = this.app.now() + 60_000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  async fetch(request: Request): Promise<Response> {
    // Persist recovery even if a caller disconnects after a queue/storage effect.
    // setAlarm promises do not delay publishing guarded private media.
    this.ctx.waitUntil(this.scheduleMaintenance());
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/health') {
        const schema = this.app.db.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_versions');
        return ok({ status: 'ok', service: 'lovelies-cloudflare-api', app_env: this.env.APP_ENV,
          database: 'cloudflare_durable_object_sqlite', database_ready: schema?.version === currentSchemaVersion,
          schema_version: schema?.version, hosted_provider_acceptance: false });
      }
      if (request.method === 'GET' && path === '/ready') {
        const missing = requiredBindings(this.env);
        const schema = this.app.db.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_versions');
        return ok({ status: missing.length ? 'unavailable' : 'ready', database_ready: schema?.version === currentSchemaVersion,
          database: 'cloudflare_durable_object_sqlite', missing, verification: 'registered_face_comparison', liveness_required: false }, missing.length ? 503 : 200);
      }
      if (path === internalPath && request.headers.get('x-lovelies-internal') === 'queue' && request.method === 'POST') {
        const message = await jsonBody(request, 16 * 1024);
        if (message.category === 'photo') await processPhotoJob(message.payload, this.app);
        else if (message.category === 'privacy') await processPrivacyJob(message.payload, this.app);
        else if (message.category === 'notification') await processNotificationJob(message.payload, this.app);
        else throw new ApiError(400, 'invalid_job');
        return ok({ status: 'processed' });
      }
      if (path.startsWith('/_internal')) throw new ApiError(404, 'route_not_found');
      if (path === '/auth/anonymous' && request.method === 'POST') await this.limitPublicAuth(request, 'anonymous');
      if (path.startsWith('/auth/face/recovery/')) await this.limitPublicAuth(request, 'recovery');
      if (path.startsWith('/auth/face/profile/')) await this.limitPublicAuth(request, 'profile');
      for (const handler of [handleAuth, handleFaceProfile, handleFaceAuth, handleIdentity, handleProfile, handleProcessing, handleSharing, handleGallery, handleEntitlements, handleOperators, handleAdminUsers, handleNotifications, handleRetention, handlePrivacy]) {
        const response = await handler(request, this.app);
        if (response) return response;
      }
      throw new ApiError(404, 'route_not_found');
    } catch (error) { return errorResponse(error); }
    finally {
      if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    }
  }

  async alarm(): Promise<void> {
    let failure: unknown;
    try {
      for (const maintain of [cleanupFaceProofs, flushPhotoOutbox, expireUploads, flushPrivacyCleanup, async (ctx: AppContext) => finishLifecycleCleanup(ctx), flushNotificationOutbox, runRetention]) {
        try { await maintain(this.app); } catch (error) { failure ??= error; }
      }
    } finally {
      const pending = this.app.db.one<{ count: number }>(`SELECT
        (SELECT count(*) FROM auth_capture_proofs) +
        (SELECT count(*) FROM photo_job_outbox WHERE status='pending') +
        (SELECT count(*) FROM cleanup_intents WHERE status<>'verified') +
        (SELECT count(*) FROM privacy_requests WHERE status IN('queued','processing')) +
        (SELECT count(*) FROM notification_jobs WHERE status IN('queued','dispatched')) +
        (SELECT count(*) FROM privacy_exports WHERE status='published') AS count`);
      if (pending && pending.count > 0) await this.ctx.storage.setAlarm(this.app.now() + 60_000);
      else {
        const obligations = [nextRetentionAt(this.app), nextFaceRecoveryAt(this.app), nextLifecycleAt(this.app),nextUploadAt(this.app)].filter((due): due is number => due !== null);
        if (obligations.length) await this.ctx.storage.setAlarm(Math.max(this.app.now()+60_000,Math.min(...obligations)));
      }
    }
    if (failure) throw failure;
  }
}

function core(env: CloudflareEnv): DurableObjectStub {
  return env.LOVELIES_CORE.get(env.LOVELIES_CORE.idFromName(authorityName));
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const origin = request.headers.get('origin');
    const allowed = new Set((env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
    if (env.PUBLIC_APP_BASE_URL) allowed.add(env.PUBLIC_APP_BASE_URL);
    if (origin && !allowed.has(origin)) {
      if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
      return ok({ error: { code: 'origin_not_allowed' } }, 403);
    }
    const headers = new Headers(request.headers);
    for (const name of sensitiveHeaders) headers.delete(name);
    headers.set('x-lovelies-address', request.headers.get('cf-connecting-ip') ?? 'local');
    let response: Response;
    try {
      if (new URL(request.url).pathname.startsWith('/_internal')) throw new ApiError(404, 'route_not_found');
      if (request.method === 'OPTIONS') {
        if (!origin) throw new ApiError(403, 'origin_required');
        response = new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Lovelies-Capture-SHA256,X-Lovelies-Device-Signature,X-Lovelies-Capture-Bytes',
          'Access-Control-Max-Age': '600',
        } });
      } else if (request.body && /^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
        // Finish the bounded control body before crossing the DO binding. An
        // early denial must not leave a native HTTP body relay reading after
        // the edge response is sent. Image upload streams retain their own caps.
        const input = await jsonBody(request);
        headers.delete('content-length'); headers.delete('transfer-encoding');
        response = await core(env).fetch(new Request(request.url, {
          method: request.method, headers, body: JSON.stringify(input),
        }));
      } else response = await core(env).fetch(new Request(request, { headers }));
    } catch (error) { response = errorResponse(error); }
    finally {
      if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    }
    const outgoing = new Headers(response.headers);
    const privateResponse = (outgoing.get('Cache-Control') ?? '').split(',').some(value => value.trim().toLowerCase() === 'private');
    outgoing.set('Cache-Control', privateResponse ? 'no-store, private' : 'no-store');
    outgoing.set('X-Content-Type-Options', 'nosniff');
    outgoing.set('Vary', 'Origin');
    if (origin) outgoing.set('Access-Control-Allow-Origin', origin);
    else outgoing.delete('Access-Control-Allow-Origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
  },
  async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        const response = await core(env).fetch(new Request(`https://lovelies.internal${internalPath}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-lovelies-internal': 'queue' },
          body: JSON.stringify(message.body),
        }));
        if (response.ok) message.ack(); else message.retry({ delaySeconds: 30 });
      } catch { message.retry({ delaySeconds: 30 }); }
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
