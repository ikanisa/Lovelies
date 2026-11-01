import { audienceContext } from './audience.ts';
import { requireQueueAdmission } from './queue-admission.ts';
import {requiresPushRoster,processPushRosterJob,pushQueueRepairEvidence,validatePushSubjectRetirement,assertNotificationEvidenceErasable,type PushSubjectRetirementProof} from './push-roster.ts';
import { ApiError, jsonBody, ok, stable, digest, uuid, record, type Actor, type AppContext, type Database } from './types.ts';
import { assertOperationNotRecovered, assertOperationReceiptAvailable, assertRegisteredActor, executeOperation, prepareOperation, type PreparedOperation } from './operations.ts';
import { accountCursor, accountPage } from './account-pagination.ts';
import { restoreOperationID } from './restore-transaction.ts';
export const notificationsSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS notification_settings(account_id TEXT PRIMARY KEY REFERENCES accounts(id),match_alerts INTEGER NOT NULL DEFAULT 1 CHECK(match_alerts IN(0,1)),payment_alerts INTEGER NOT NULL DEFAULT 1 CHECK(payment_alerts IN(0,1)),support_alerts INTEGER NOT NULL DEFAULT 1 CHECK(support_alerts IN(0,1)),updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),auth_device_id TEXT NOT NULL REFERENCES auth_devices(id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),token_hash TEXT NOT NULL UNIQUE,token_value TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN('match','payment','support')),entity_id TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(account_id,kind,entity_id))`,
    `CREATE TABLE IF NOT EXISTS notification_jobs(notification_id TEXT PRIMARY KEY REFERENCES notifications(id),account_id TEXT NOT NULL REFERENCES accounts(id),auth_epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','dispatched','accepted','ambiguous','cancelled','inbox_only')),created_at INTEGER NOT NULL,dispatched_at INTEGER,last_examined_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS notification_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),device_id TEXT NOT NULL REFERENCES push_devices(id),operation_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN('queued','dispatching','accepted','ambiguous','cancelled')),token_hash TEXT NOT NULL,provider_receipt TEXT,lease_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,request_sha256 TEXT,platform TEXT,provider_outcome TEXT,UNIQUE(notification_id,device_id))`,
    `CREATE INDEX IF NOT EXISTS notification_account ON notifications(account_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS notification_outbox_scan ON notification_jobs(coalesce(last_examined_at,0),created_at,notification_id) WHERE status IN('queued','dispatched','ambiguous')`,
];
export async function initNotificationsSchema(db: Database): Promise<void> { for (const sql of notificationsSchemaStatements)
    (await db.run(sql)); }
async function settings(ctx: AppContext, account: string): Promise<Record<string, unknown>> {
    const row = (await ctx.db.one<any>('SELECT * FROM notification_settings WHERE account_id=?', account));
    return { user_id: account, match_alerts: row ? row.match_alerts === 1 : true, payment_alerts: row ? row.payment_alerts === 1 : true, support_alerts: row ? row.support_alerts === 1 : true };
}
async function permitted(ctx: AppContext, account: string, kind: string, epoch?: number): Promise<boolean> {
    const row = (await ctx.db.one<any>('SELECT identity_state,disabled_at,auth_epoch FROM accounts WHERE id=?', account));
    if (kind !== 'support' && !await audienceContext(ctx, account, kind === 'match' ? 'photo_matching' : 'face_authentication')) return false;
    return !!row && row.identity_state === 'registered_face' && row.disabled_at === null && (epoch == null || row.auth_epoch === epoch) && (await settings(ctx, account))[kind + '_alerts'] === true;
}
function pristineQueuedDelivery(row: {status: string; attempts: number; provider_receipt: unknown; lease_token: unknown; lease_until: unknown}): boolean {
    return row.status === 'queued' && row.attempts === 0 && row.provider_receipt === null && row.lease_token === null && row.lease_until === null;
}
/** Only this explicit type may be isolated to one delivery. Database, restore,
 * admission and unexpected internal errors must still stop the entire worker. */
class NotificationDeliveryHold extends ApiError {}
async function fetchPushReceipt(ctx: AppContext, url: string, init: RequestInit, operation: string, requestHash: string): Promise<Record<string, any>> {
    let response: Response;
    try { response = await ctx.env.PUSH_SERVICE!.fetch(url, init); }
    catch { throw new NotificationDeliveryHold(503, 'push_provider_unavailable'); }
    try { return await readPushReceipt(response, operation, requestHash); }
    catch (error) {
        if (error instanceof ApiError && error.code === 'json_body_configuration_invalid') throw error;
        // These failures came only from parsing an external response. They may
        // hold this delivery without disguising a database failure as transport.
        throw new NotificationDeliveryHold(503, error instanceof ApiError ? error.code : 'push_receipt_unbound');
    }
}
async function readPushReceipt(response: Response, operation: string, requestHash: string): Promise<Record<string, any>> {
    if (response.redirected || response.status >= 300 && response.status < 400) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* Preserve redirect denial. */ }
        throw new ApiError(503, 'push_provider_redirect_denied');
    }
    // A pinned gateway may return a durable disposition with HTTP503. Inspect
    // the exact bounded receipt before deciding whether anything is confirmed.
    const receipt = await jsonBody(response as unknown as Request, 8192);
    if (receipt.operation_key !== operation || receipt.protocol !== 'lovelies-push-dispatch-receipt-v1' ||
        !['accepted','rejected','not_dispatched','ambiguous','preparing','dispatching','unknown'].includes(receipt.status))
        throw new ApiError(503, 'push_receipt_unbound');
    // An absent independent operation never authorizes resend.
    if (!(receipt.status === 'unknown' && receipt.request_sha256 === null) && receipt.request_sha256 !== requestHash)
        throw new ApiError(503, 'push_receipt_unbound');
    return receipt;
}
/** Internal producer only. Titles contain no photos, tokens, counterpart names
 * or links; opening the entity still requires the usual current authority. */
export async function enqueueNotification(ctx: AppContext, account: string, kind: 'match' | 'payment' | 'support', entity: string, title: string): Promise<string | null> {
    if (!(await permitted(ctx, account, kind)))
        return null;
    if (!title || title.length > 160 || /[\u0000-\u001f]/.test(title))
        throw new ApiError(500, 'notification_content_invalid');
    const existing = (await ctx.db.one<{
        id: string;
    }>('SELECT id FROM notifications WHERE account_id=? AND kind=? AND entity_id=?', account, kind, entity));
    if (existing)
        return existing.id;
    const id = crypto.randomUUID(), epoch = (await ctx.db.one<{
        auth_epoch: number;
    }>('SELECT auth_epoch FROM accounts WHERE id=?', account))!.auth_epoch;
    (await ctx.db.run('INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,?,?,?,?)', id, account, kind, entity, title, ctx.now()));
    (await ctx.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,?,'queued',?)", id, account, epoch, ctx.now()));
    return id;
}
export async function handleNotifications(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname, read = /^\/me\/notifications\/([0-9a-f-]{36})\/read$/i.exec(path), device = /^\/me\/push-devices\/([0-9a-f-]{36})$/i.exec(path);
    const notification = /^\/me\/notifications\/([0-9a-f-]{36})$/i.exec(path);
    const pushOperation = path === '/me/push-operations';
    if (!['/me/notification-settings', '/me/notifications', '/me/push-devices'].includes(path) && !read && !device && !pushOperation && !notification)
        return null;
    const actor = await ctx.authenticate(request);
    (await assertRegisteredActor(ctx, actor));
    if (pushOperation) {
        if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
        if (new URL(request.url).search) throw new ApiError(400, 'invalid_input');
        const input=await jsonBody(request,1024);
        await assertRegisteredActor(ctx, actor);
        if (Object.keys(input).join(',')!=='operation_key' || typeof input.operation_key!=='string' ||
            !/^[A-Za-z0-9._:-]{16,128}$/.test(input.operation_key)) throw new ApiError(400, 'invalid_input');
        const key=input.operation_key as string, protocol = 'lovelies-push-operation-receipt-v1';
        return ok(await ctx.db.read(async () => {
            await assertRegisteredActor(ctx, actor);
            try {
            await assertOperationNotRecovered(ctx, actor.accountId, 'notification', key);
            const operation = await ctx.db.one<{action:string;payload_hash:string;payload_json:string;response_json:string}>(
                "SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?", actor.accountId,key);
            // The result of this read is available only to the still-current session.
            await assertRegisteredActor(ctx, actor);
            if (!operation) return {protocol,operation_key:key,status:'unknown'};
            assertOperationReceiptAvailable(operation);
            const register = operation.action === 'notification./me/push-devices.POST';
            const removed = /^notification\.\/me\/push-devices\/([0-9a-f-]{36})\.DELETE$/i.exec(operation.action);
            if (!register && !removed) throw new ApiError(409,'push_operation_scope_changed');
            const unavailable=():never=>{throw new ApiError(503,'push_operation_receipt_unavailable');};
            const receiptId=(input:unknown):string=>{try{return uuid(input);}catch{return unavailable();}};
            if (typeof operation.payload_hash !== 'string' || !/^[0-9a-f]{64}$/.test(operation.payload_hash) ||
                typeof operation.payload_json !== 'string' || new TextEncoder().encode(operation.payload_json).byteLength > 16384 ||
                typeof operation.response_json !== 'string' || new TextEncoder().encode(operation.response_json).byteLength > 16384) unavailable();
            let parsedPayload:unknown, result:unknown;
            try { parsedPayload=JSON.parse(operation.payload_json); result=JSON.parse(operation.response_json); }
            catch { return unavailable(); }
            if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload) ||
                !result || typeof result !== 'object' || Array.isArray(result)) return unavailable();
            const payload=parsedPayload as Record<string,unknown>, value=result as Record<string,unknown>;
            if (payload.operation_key!==key) unavailable();
            const id=receiptId(value.id);
            let tokenHash:string | undefined;
            if (register) {
                const fields=Object.keys(payload).sort().join(',');
                if (!['ios','android'].includes(payload.platform as string) || value.platform!==payload.platform ||
                    Object.keys(value).sort().join(',')!=='active,id,platform' || value.active!==true) unavailable();
                if (fields==='operation_key,platform,protocol,push_token_sha256' &&
                    payload.protocol==='lovelies-push-registration-receipt-v1' && typeof payload.push_token_sha256==='string' &&
                    /^[0-9a-f]{64}$/.test(payload.push_token_sha256)) tokenHash=payload.push_token_sha256;
                else if (fields==='operation_key,platform,push_token' && typeof payload.push_token==='string' &&
                    payload.push_token.length>=16 && payload.push_token.length<=4096 && !/\s/.test(payload.push_token) &&
                    !key.includes(payload.push_token)) tokenHash=await digest(payload.push_token);
                else unavailable();
            } else {
                if (Object.keys(payload).sort().join(',')!=='device_id,operation_key' || receiptId(payload.device_id)!==receiptId(removed![1]) ||
                    Object.keys(value).sort().join(',')!=='active,id' || value.active!==false || id!==receiptId(removed![1])) unavailable();
            }
            // Only flat, validated values reach canonicalization; malformed nested
            // payloads cannot drive unbounded recursive serialization here.
            if (stable(payload)!==operation.payload_json || stable(value)!==operation.response_json ||
                await digest(stable({action:operation.action,source:'notification',payload}))!==operation.payload_hash) unavailable();
            const current=await ctx.db.one<{id:string;auth_device_id:string;platform:string;active:number;token_hash:string}>(
                'SELECT id,auth_device_id,platform,active,token_hash FROM push_devices WHERE id=? AND account_id=?',id,actor.accountId);
            if (!current || !['ios','android'].includes(current.platform) || ![0,1].includes(current.active) ||
                receiptId(current.id)!==id || (register && current.token_hash!==tokenHash)) return unavailable();
            const currentDevice=receiptId(current.auth_device_id);
            const session=await ctx.db.one<{device_id:string}>('SELECT device_id FROM sessions WHERE id=? AND account_id=?',actor.sessionId,actor.accountId);
            if (!session || receiptId(session.device_id)!==currentDevice) throw new ApiError(404,'push_operation_unavailable');
            await assertRegisteredActor(ctx, actor);
            // Never return the raw legacy payload or the current token hash.
            return {protocol,operation_key:key,status:'committed',action:operation.action,payload_hash:operation.payload_hash,
                result:register?{id,platform:value.platform,active:true}:{id,active:false},
                current:{id,auth_device_id:currentDevice,platform:current.platform,active:current.active}};
            } catch (error) {
                // A state-specific error may follow an awaited read/hash just
                // as a successful receipt does. Recheck before releasing it.
                await assertRegisteredActor(ctx, actor);
                throw error;
            }
        }));
    }
    if (notification || path === '/me/notifications' && request.method === 'GET') {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        return ok(await ctx.db.read(async () => {
            await assertRegisteredActor(ctx, actor);
            if (notification) {
                const item = await ctx.db.one('SELECT id,kind,entity_id,title,created_at,read_at FROM notifications WHERE id=? AND account_id=?', uuid(notification[1]), actor.accountId);
                if (!item) throw new ApiError(404, 'notification_unavailable');
                await assertRegisteredActor(ctx, actor);
                return { notification: item };
            }
            if ([...url.searchParams.keys()].some(key => !['limit','cursor'].includes(key)) || url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1) throw new ApiError(400,'invalid_notification_page');
            const { limit, cursor } = accountPage({ limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') }, actor.accountId, 'notifications');
            const rows = await ctx.db.all<{ id: string; created_at: number }>('SELECT id,kind,entity_id,title,created_at,read_at FROM notifications WHERE account_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?', actor.accountId, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1);
            const items = rows.slice(0, limit), total = (await ctx.db.one<{ n: number }>('SELECT count(*) n FROM notifications WHERE account_id=?', actor.accountId))!.n;
            await assertRegisteredActor(ctx, actor);
            return { items, notifications: items, page: { limit, total, next_cursor: rows.length > limit ? accountCursor(items.at(-1)!, actor.accountId, 'notifications') : null } };
        }));
    }
    if (request.method === 'GET')
        return ok((await ctx.db.transaction(async () => { (await assertRegisteredActor(ctx, actor)); if (path === '/me/notification-settings')
            return (await settings(ctx, actor.accountId)); if (path === '/me/push-devices')
            return { items: (await ctx.db.all('SELECT id,auth_device_id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=?', actor.accountId)) }; throw new ApiError(405, 'method_not_allowed'); })));
    if (!['POST', 'PATCH', 'DELETE'].includes(request.method))
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    const allowed = path === '/me/notification-settings' ? ['match_alerts', 'payment_alerts', 'support_alerts', 'operation_key'] : path === '/me/push-devices' ? ['platform', 'push_token', 'operation_key'] : ['operation_key'];
    if (Object.keys(body).some(key => !allowed.includes(key)))
        throw new ApiError(400, 'invalid_input');
    let tokenHash: string | undefined;
    if (path === '/me/push-devices') {
        if (request.method !== 'POST' || !['ios', 'android'].includes(body.platform) || typeof body.push_token !== 'string' || body.push_token.length < 16 || body.push_token.length > 4096 || /\s/.test(body.push_token))
            throw new ApiError(400, 'push_device_invalid');
        tokenHash = await digest(body.push_token);
    }
    const intent = await prepareOperation('notification.' + path + '.' + request.method, { ...body, ...(read ? { notification_id: uuid(read[1]) } : device ? { device_id: uuid(device[1]) } : {}) }, 'notification');
    // New push receipts commit a token digest, not a second plaintext copy.
    // Exact legacy rows retain their original identity and response on retry.
    const redacted = tokenHash === undefined ? undefined : await prepareOperation(intent.action, {
        protocol: 'lovelies-push-registration-receipt-v1', operation_key: intent.key,
        platform: body.platform, push_token_sha256: tokenHash,
    }, 'notification');
    const execute = (selected: PreparedOperation) => executeOperation(ctx, actor, selected, async () => {
        if (path === '/me/notification-settings') {
            if (request.method !== 'PATCH')
                throw new ApiError(405, 'method_not_allowed');
            (await ctx.db.run('INSERT OR IGNORE INTO notification_settings(account_id,updated_at) VALUES(?,?)', actor.accountId, ctx.now()));
            for (const name of ['match_alerts', 'payment_alerts', 'support_alerts'])
                if (Object.hasOwn(body, name)) {
                    if (typeof body[name] !== 'boolean')
                        throw new ApiError(400, 'invalid_notification_setting');
                    (await ctx.db.run('UPDATE notification_settings SET ' + name + '=?,updated_at=? WHERE account_id=?', body[name] ? 1 : 0, ctx.now(), actor.accountId));
                }
            return (await settings(ctx, actor.accountId));
        }
        if (read) {
            if (request.method !== 'POST')
                throw new ApiError(405, 'method_not_allowed');
            const id = uuid(read[1]);
            if (!(await ctx.db.one('SELECT id FROM notifications WHERE id=? AND account_id=?', id, actor.accountId)))
                throw new ApiError(404, 'notification_unavailable');
            (await ctx.db.run('UPDATE notifications SET read_at=coalesce(read_at,?) WHERE id=?', ctx.now(), id));
            return { id, read: true };
        }
        if (device) {
            if (request.method !== 'DELETE')
                throw new ApiError(405, 'method_not_allowed');
            const id = uuid(device[1]);
            if (!(await ctx.db.one('SELECT id FROM push_devices WHERE id=? AND account_id=?', id, actor.accountId)))
                throw new ApiError(404, 'push_device_unavailable');
            (await ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE id=?", ctx.now(), id));
            // Retiring this device prevents future dispatch; it does not settle
            // an already attempted or otherwise uncertain provider operation.
            await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE device_id=? AND status='queued' AND attempts=0 AND provider_receipt IS NULL AND lease_token IS NULL AND lease_until IS NULL",ctx.now(),id);
            return { id, active: false };
        }
        const current = (await ctx.db.one<{
            device_id: string;
        }>('SELECT device_id FROM sessions WHERE id=?', actor.sessionId))!;
        let prior = (await ctx.db.one<any>('SELECT id,account_id,active FROM push_devices WHERE token_hash=?', tokenHash!));
        if (prior && prior.account_id !== actor.accountId) {
            if (prior.active === 1) throw new ApiError(403,'push_token_owner_conflict');
            // Keep old-account delivery history bound to the old device row.
            // An explicitly deactivated token can be registered by the next
            // verified account on this phone without moving that history.
            await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE device_id=? AND status='queued' AND attempts=0 AND provider_receipt IS NULL AND lease_token IS NULL AND lease_until IS NULL",ctx.now(),prior.id);
            await ctx.db.run("UPDATE push_devices SET token_hash=?,token_value='',updated_at=? WHERE id=? AND active=0",await digest('retired:'+prior.id+':'+tokenHash),ctx.now(),prior.id);
            prior=null;
        }
        // A token rotation can replace an active registration on this same
        // device/platform; an inactive saved token still consumes a slot when
        // reactivated. Calculate the result before mutating either row.
        const active = (await ctx.db.one<{ n: number }>('SELECT count(*) n FROM push_devices WHERE account_id=? AND active=1', actor.accountId))!.n;
        const displaced = (await ctx.db.one<{ n: number }>(`SELECT count(*) n FROM push_devices
            WHERE account_id=? AND auth_device_id=? AND platform=? AND id<>? AND active=1`,
            actor.accountId, current.device_id, body.platform as string, prior?.id ?? ''))!.n;
        const prospective = active + (prior?.active === 1 ? 0 : 1) - displaced;
        // Preserve pre-existing over-limit accounts without increasing their
        // active count; this does not silently retire or migrate their devices.
        if (prospective > 10 && prospective > active)
            throw new ApiError(409, 'push_device_limit');
        const id = prior?.id ?? crypto.randomUUID();
        (await ctx.db.run('INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET auth_device_id=excluded.auth_device_id,platform=excluded.platform,token_value=excluded.token_value,active=1,updated_at=excluded.updated_at', id, actor.accountId, current.device_id, body.platform, tokenHash!, body.push_token, ctx.now(), ctx.now()));
        await ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE account_id=? AND auth_device_id=? AND platform=? AND id<>? AND active=1",ctx.now(),actor.accountId,current.device_id,body.platform,id);
        return { id, platform: body.platform, active: true };
    });
    if (!redacted) return ok(await execute(intent));
    return ok(await ctx.db.transaction(async () => {
        await assertRegisteredActor(ctx, actor);
        const previous = await ctx.db.one<{action: string; payload_hash: string}>(
            'SELECT action,payload_hash FROM operations WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, intent.source, intent.key);
        // A legacy receipt uses the original raw-input hash, including retired
        // receipts. The shared operation engine still checks exact payload.
        if (previous && previous.action === intent.action && previous.payload_hash === intent.hash) return execute(intent);
        if (!previous) {
            const recovered = await ctx.db.one<{input_hash: string}>(
                'SELECT input_hash FROM restore_recovered_operations WHERE operation_id=?',
                await restoreOperationID(actor.accountId, intent.source, intent.key));
            // Recovery keeps the accepted hash even when SQL never committed a
            // receipt. Preserve that legacy identity only for an exact match;
            // the shared engine rechecks current authority and returns 410/409
            // before entering registration or persisting either payload.
            if (recovered) return execute(recovered.input_hash === intent.hash ? intent : redacted);
            if (intent.key.includes(body.push_token as string)) throw new ApiError(400, 'push_token_in_operation_key');
        }
        return execute(redacted);
    }));
}
/** Recompute from durable delivery evidence; withdrawing permission prevents
 * future dispatch but can never turn an earlier send into a non-send. */
async function notificationDisposition(ctx: AppContext, id: string): Promise<boolean> {
    return ctx.db.transaction(async () => {
        const job = await ctx.db.one<any>('SELECT j.*,n.kind FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?', id);
        if (!job) return false;
        const totals = (await ctx.db.one<{n:number;uncertain:number|null;accepted:number|null}>(`SELECT count(*) n,
            sum(CASE WHEN status IN('dispatching','ambiguous') OR status='queued' AND(attempts>0 OR provider_receipt IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL) THEN 1 ELSE 0 END) uncertain,
            sum(CASE WHEN status='accepted' THEN 1 ELSE 0 END) accepted FROM notification_deliveries WHERE notification_id=?`,id))!;
        // A current terminal/ambiguous aggregate is itself retained evidence.
        // Missing rows cannot let an older worker revise that disposition. When
        // rows remain, their unresolved operations still require reconciliation.
        if(totals.n===0&&['accepted','cancelled','inbox_only','ambiguous'].includes(job.status))return job.status==='ambiguous';
        const uncertain = (totals.uncertain??0)>0;
        const allowed = await permitted(ctx, job.account_id, job.kind, job.auth_epoch);
        if (!allowed) await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE notification_id=? AND status='queued' AND attempts=0 AND provider_receipt IS NULL AND lease_token IS NULL AND lease_until IS NULL", ctx.now(), id);
        const status = uncertain ? 'ambiguous' : (totals.accepted??0)>0 ? 'accepted' : allowed ? 'inbox_only' : 'cancelled';
        await ctx.db.run('UPDATE notification_jobs SET status=? WHERE notification_id=?', status, id);
        return uncertain;
    });
}
export async function flushNotificationOutbox(ctx: AppContext): Promise<void> {
    // Examining an item is distinct from handing it to the queue. The durable
    // examination mark advances even if an old queue identity cannot be reused;
    // a held or failed item cannot monopolize every bounded maintenance pass.
    const rows = await ctx.db.transaction(async () => {
        const selected = await ctx.db.all<any>(`SELECT j.*,n.kind FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id
            WHERE (j.status IN('queued','dispatched','ambiguous') OR EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.notification_id=j.notification_id AND (d.status IN('dispatching','ambiguous') OR d.status='queued' AND (d.attempts>0 OR d.provider_receipt IS NOT NULL OR d.lease_token IS NOT NULL OR d.lease_until IS NOT NULL)))) AND (j.dispatched_at IS NULL OR j.dispatched_at<=?)
              AND (j.last_examined_at IS NULL OR j.last_examined_at<=?)
            ORDER BY coalesce(j.last_examined_at,0),j.created_at,j.notification_id LIMIT 25`, ctx.now() - 60000, ctx.now() - 60000);
        for (const row of selected) await ctx.db.run('UPDATE notification_jobs SET last_examined_at=? WHERE notification_id=?', Math.max(ctx.now(), row.last_examined_at ?? 0), row.notification_id);
        return selected;
    });
    let failure: unknown;
    for (const row of rows) {
        try {
            // V2 must consult its independent complete plan even after local
            // authority loss or a restore that removed every delivery row.
            if (!await requiresPushRoster(ctx,row.notification_id)&&!await permitted(ctx,row.account_id,row.kind,row.auth_epoch)&&!await notificationDisposition(ctx,row.notification_id)) continue;
            const receipt = await ctx.env.PHOTO_JOBS.send({ category: 'notification', payload: { notification_id: row.notification_id } });
            requireQueueAdmission(receipt);
            // A queue refresh does not settle an earlier uncertain provider send.
            await ctx.db.run("UPDATE notification_jobs SET status=CASE WHEN status='queued' THEN 'dispatched' ELSE status END,dispatched_at=? WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')", ctx.now(), row.notification_id);
        } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
}
function pushPayload(job:any,device:any,operation:string):Record<string,any>{
    // Keep the order identical to the private gateway's parseDispatch output.
    // Hashing the original token binds reconciliation after token erasure without
    // retaining another plaintext token or creating permission to send it again.
    return {operation_key:operation,platform:device.platform,token:device.token_value,
        notification:{id:job.notification_id,title:job.title,kind:job.kind,entity_id:job.entity_id}};
}
async function assertRetainedNotificationHistory(ctx:AppContext,job:{notification_id:string;status:string}):Promise<void>{
    if(job.status==='ambiguous'&&!await ctx.db.one('SELECT id FROM notification_deliveries WHERE notification_id=? LIMIT 1',job.notification_id))
        throw new ApiError(503,'push_reconciliation_required');
}
export async function processNotificationJob(payload: unknown, ctx: AppContext): Promise<void> {
    const body=record(payload);
    if(Object.keys(body).some(key=>key!=='notification_id'))throw new ApiError(400,'invalid_job');
    const id=uuid(body.notification_id);
    const job=await ctx.db.one<any>('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?',id);
    if(!job)return;
    if(await requiresPushRoster(ctx,id))return processPushRosterJob(ctx,job,()=>permitted(ctx,job.account_id,job.kind,job.auth_epoch));
    // Do not replace absent uncertain history with a new device operation, even
    // if a current registration could otherwise receive this notification.
    await assertRetainedNotificationHistory(ctx,job);
    const pending=await ctx.db.one("SELECT id FROM notification_deliveries WHERE notification_id=? AND (status IN('dispatching','ambiguous') OR status='queued' AND (attempts>0 OR provider_receipt IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL)) LIMIT 1",id);
    if(['accepted','cancelled','inbox_only'].includes(job.status)&&!pending)return;
    const allowed=await permitted(ctx,job.account_id,job.kind,job.auth_epoch);
    // Existing delivery rows are reconciled even when a token/device or account
    // has been retired. Only current active registrations can add new rows.
    const devices=allowed&&!['accepted','cancelled','inbox_only'].includes(job.status)
        ?await ctx.db.all<any>("SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active' WHERE p.account_id=? AND p.active=1 ORDER BY p.id LIMIT 10",job.account_id):[];
    if(devices.length&&!ctx.env.PUSH_SERVICE)throw new ApiError(503,'push_provider_unavailable');
    await ctx.db.transaction(async()=>{
        const current=await ctx.db.one<{notification_id:string;status:string}>('SELECT notification_id,status FROM notification_jobs WHERE notification_id=?',id);
        if(!current||['accepted','cancelled','inbox_only'].includes(current.status))return;
        await assertRetainedNotificationHistory(ctx,current);
        if(!await permitted(ctx,job.account_id,job.kind,job.auth_epoch))return;
        for(const device of devices)await ctx.db.run("INSERT OR IGNORE INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,platform,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?)",crypto.randomUUID(),id,device.id,'notification:'+id+':'+device.id,device.token_hash,device.platform,ctx.now(),ctx.now());
    });
    // Bound each pass across active and retired devices together. Examination
    // timestamps advance monotonically, so a busy or unbound historical row
    // cannot monopolize every pass and hide later independent receipts.
    const lastExamined=(await ctx.db.one<{last:number|null}>("SELECT max(updated_at) AS last FROM notification_deliveries WHERE notification_id=? AND status NOT IN('accepted','cancelled')",id))?.last??0;
    const examination=Math.max(ctx.now(),lastExamined+1);
    if(!Number.isSafeInteger(examination))throw new ApiError(503,'push_receipt_sequence_exhausted');
    const deliveries=await ctx.db.all<any>("SELECT * FROM notification_deliveries WHERE notification_id=? AND status NOT IN('accepted','cancelled') ORDER BY updated_at,created_at,id LIMIT 25",id);
    const activeDevice=async(delivery:any):Promise<any|null>=>ctx.db.one<any>(`SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active'
        WHERE p.id=? AND p.account_id=? AND p.active=1 AND p.token_hash=? AND (? IS NULL OR p.platform=?)`,delivery.device_id,job.account_id,delivery.token_hash,delivery.platform??null,delivery.platform??null);
    let unresolved=false,observedFailure:unknown;
    for(const snapshot of deliveries){
        const lease=crypto.randomUUID();
        const claimed=await ctx.db.transaction(async()=>{
            const row=await ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE id=?',snapshot.id);
            if(!row||['accepted','cancelled'].includes(row.status))return null;
            row.updated_at=Math.max(examination,row.updated_at+1);
            await ctx.db.run('UPDATE notification_deliveries SET updated_at=? WHERE id=?',row.updated_at,row.id);
            if((row.status==='dispatching'||row.status==='queued'&&!pristineQueuedDelivery(row))&&row.lease_until>ctx.now())return {busy:true,row};
            const device=await activeDevice(row),permit=await permitted(ctx,job.account_id,job.kind,job.auth_epoch);
            const untouched=pristineQueuedDelivery(row);
            if(untouched&&(!device||!permit)){
                await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE id=?",ctx.now(),row.id);return null;
            }
            if(untouched){
                const hash=await digest(JSON.stringify(pushPayload(job,device,row.operation_key)));
                if(row.request_sha256!==null&&row.request_sha256!==hash)throw new ApiError(503,'push_reconciliation_required');
                await ctx.db.run('UPDATE notification_deliveries SET request_sha256=?,platform=? WHERE id=?',hash,device.platform,row.id);
                row.request_sha256=hash;row.platform=device.platform;
            }
            // A legacy uncertain row without its original request binding is
            // retained for reconciliation; a replacement token cannot invent it.
            if(!row.request_sha256||!row.platform)return {busy:true,row,code:'push_delivery_binding_unavailable'};
            await ctx.db.run("UPDATE notification_deliveries SET status='dispatching',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?",lease,ctx.now()+60000,row.updated_at,row.id);
            return {busy:false,row,device,untouched};
        });
        if(!claimed)continue;
        if(claimed.busy){unresolved=true;if(claimed.code)observedFailure??=new NotificationDeliveryHold(503,claimed.code);continue;}
        const delivery=claimed.row,operation=delivery.operation_key;
        try{
            if(!ctx.env.PUSH_SERVICE)throw new ApiError(503,'push_provider_unavailable');
            const cancelUndispatched=async()=>ctx.db.run("UPDATE notification_deliveries SET status='cancelled',provider_outcome='not_dispatched',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='dispatching'",ctx.now(),delivery.id,lease);
            const send=async():Promise<Record<string,any>|null>=>{
                const input=await ctx.db.transaction(async()=>{
                    const current=await ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE id=?',delivery.id),device=await activeDevice(delivery);
                    if(!current||current.status!=='dispatching'||current.lease_token!==lease)return null;
                    if(!device||!await permitted(ctx,job.account_id,job.kind,job.auth_epoch)){await cancelUndispatched();return null;}
                    const value=pushPayload(job,device,operation);
                    if(await digest(JSON.stringify(value))!==delivery.request_sha256)throw new ApiError(503,'push_dispatch_binding_changed');
                    return value;
                });
                if(!input)return null;
                return fetchPushReceipt(ctx,'https://push.internal/send',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:stable(input)},operation,delivery.request_sha256);
            };
            let receipt=claimed.untouched?await send():await fetchPushReceipt(ctx,'https://push.internal/operations/'+encodeURIComponent(operation),{redirect:'manual'},operation,delivery.request_sha256);
            if(!receipt)continue;
            if(receipt.status==='not_dispatched'&&!claimed.untouched){
                if(delivery.attempts>=5){await cancelUndispatched();continue;}
                receipt=await send();if(!receipt)continue;
            }
            if(receipt.status==='rejected'){
                if(typeof receipt.provider_code!=='string'||!receipt.provider_code||receipt.provider_code.length>160||typeof receipt.retryable!=='boolean'||typeof receipt.token_invalid!=='boolean')throw new ApiError(503,'push_receipt_unbound');
                await ctx.db.transaction(async()=>{
                    await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',provider_outcome='rejected',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND request_sha256=? AND status<>'accepted'",ctx.now(),delivery.id,delivery.request_sha256);
                    if(receipt!.token_invalid)await ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE id=? AND account_id=? AND token_hash=?",ctx.now(),delivery.device_id,job.account_id,delivery.token_hash);
                });continue;
            }
            if(receipt.status!=='accepted')throw new ApiError(503,'push_reconciliation_required');
            if(typeof receipt.provider_message_id!=='string'||!receipt.provider_message_id||receipt.provider_message_id.length>256)throw new ApiError(503,'push_delivery_unconfirmed');
            await ctx.db.transaction(async()=>{
                const current=await ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE id=?',delivery.id);
                if(!current)return; // Erasure must never resurrect a delivery row.
                if(current.operation_key!==operation||current.request_sha256!==delivery.request_sha256||current.platform!==delivery.platform||current.token_hash!==delivery.token_hash||current.status==='accepted'&&current.provider_receipt!==receipt!.provider_message_id)throw new ApiError(503,'push_receipt_unbound');
                // This is evidence of an old send, not permission for a new one.
                // Preserve it after logout, opt-out, token rotation or lease loss.
                await ctx.db.run("UPDATE notification_deliveries SET status='accepted',provider_outcome='accepted',provider_receipt=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",receipt!.provider_message_id,Math.max(ctx.now(),current.updated_at),delivery.id);
            });
        }catch(error){
            await ctx.db.run("UPDATE notification_deliveries SET status='ambiguous',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='dispatching'",Math.max(ctx.now(),delivery.updated_at),delivery.id,lease);
            if(!(error instanceof ApiError))throw error;
            if(!(error instanceof NotificationDeliveryHold)&&!['push_reconciliation_required','push_delivery_unconfirmed','push_receipt_unbound','push_provider_unavailable'].includes(error.code))throw error;
            unresolved=true;observedFailure??=error;
        }
    }
    if(await notificationDisposition(ctx,id)||unresolved)throw observedFailure instanceof ApiError?observedFailure:new ApiError(503,'push_reconciliation_required');
}
export async function notificationQueueRepairEvidence(ctx:AppContext,id:string):Promise<Record<string,unknown>>{
    const job=await ctx.db.one<any>('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?',id);
    if(!job||!['queued','dispatched','ambiguous'].includes(job.status)||!await permitted(ctx,job.account_id,job.kind,job.auth_epoch))
        throw new ApiError(409,'queue_notification_authority_changed');
    const proof=await pushQueueRepairEvidence(ctx,job);
    if(!await permitted(ctx,job.account_id,job.kind,job.auth_epoch))throw new ApiError(409,'queue_notification_authority_changed');
    return {account_id:job.account_id,domain_status:job.status,outbox_id:id,
        notification:{id,account_id:job.account_id,auth_epoch:job.auth_epoch,kind:job.kind,title:job.title,entity_id:job.entity_id,created_at:job.created_at},proof};
}
export async function notificationPrivacyRows(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const rows = { notification_settings: (await settings(ctx, subject)), notifications: (await ctx.db.all('SELECT id,kind,title,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)), push_devices: (await ctx.db.all('SELECT id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)),
        notification_dispatch_plans:await ctx.db.all('SELECT p.notification_id,p.provider_generation,p.plan_sha256,p.created_at FROM notification_dispatch_plans p JOIN notifications n ON n.id=p.notification_id WHERE n.account_id=? ORDER BY p.created_at,p.notification_id LIMIT 25001',subject),
        notification_recovered_receipts:await ctx.db.all('SELECT r.operation_key,r.notification_id,r.device_id,r.status,r.provider_receipt,r.provider_code,r.created_at,r.updated_at FROM notification_recovered_receipts r JOIN notifications n ON n.id=r.notification_id WHERE n.account_id=? ORDER BY r.created_at,r.operation_key LIMIT 25001',subject)};
    if (rows.notifications.length > 25000 || rows.push_devices.length > 25000||rows.notification_dispatch_plans.length>25000||rows.notification_recovered_receipts.length>25000)
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
export async function eraseNotificationSubject(ctx: AppContext, subject: string, proof:PushSubjectRetirementProof|null): Promise<void> {
    await validatePushSubjectRetirement(ctx,subject,proof);
    await assertNotificationEvidenceErasable(ctx.db,subject);
    const db=ctx.db;
    (await db.run('DELETE FROM notification_deliveries WHERE notification_id IN(SELECT id FROM notifications WHERE account_id=?) OR device_id IN(SELECT id FROM push_devices WHERE account_id=?)', subject, subject));
    (await db.run('DELETE FROM notification_jobs WHERE account_id=?', subject));
    (await db.run('DELETE FROM notifications WHERE account_id=?', subject));
    (await db.run('DELETE FROM push_devices WHERE account_id=?', subject));
    (await db.run('DELETE FROM notification_settings WHERE account_id=?', subject));
}
