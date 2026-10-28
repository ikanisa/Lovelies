import { audienceContext } from './audience.ts';
import { ApiError, jsonBody, ok, stable, digest, uuid, record, type Actor, type AppContext, type Database } from './types.ts';
import { assertOperationReceiptAvailable, assertRegisteredActor, executeOperation, prepareOperation, type PreparedOperation } from './operations.ts';
export const notificationsSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS notification_settings(account_id TEXT PRIMARY KEY REFERENCES accounts(id),match_alerts INTEGER NOT NULL DEFAULT 1 CHECK(match_alerts IN(0,1)),payment_alerts INTEGER NOT NULL DEFAULT 1 CHECK(payment_alerts IN(0,1)),support_alerts INTEGER NOT NULL DEFAULT 1 CHECK(support_alerts IN(0,1)),updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),auth_device_id TEXT NOT NULL REFERENCES auth_devices(id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),token_hash TEXT NOT NULL UNIQUE,token_value TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN('match','payment','support')),entity_id TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(account_id,kind,entity_id))`,
    `CREATE TABLE IF NOT EXISTS notification_jobs(notification_id TEXT PRIMARY KEY REFERENCES notifications(id),account_id TEXT NOT NULL REFERENCES accounts(id),auth_epoch INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','dispatched','accepted','ambiguous','cancelled','inbox_only')),created_at INTEGER NOT NULL,dispatched_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS notification_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),device_id TEXT NOT NULL REFERENCES push_devices(id),operation_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN('queued','dispatching','accepted','ambiguous','cancelled')),token_hash TEXT NOT NULL,provider_receipt TEXT,lease_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(notification_id,device_id))`,
    `CREATE INDEX IF NOT EXISTS notification_account ON notifications(account_id,created_at)`,
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
    const path = new URL(request.url).pathname, read = /^\/me\/notifications\/([0-9a-f-]{36})\/read$/i.exec(path), device = /^\/me\/push-devices\/([0-9a-f-]{36})$/i.exec(path);
    const pushOperation = path === '/me/push-operations';
    if (!['/me/notification-settings', '/me/notifications', '/me/push-devices'].includes(path) && !read && !device && !pushOperation)
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
    if (request.method === 'GET')
        return ok((await ctx.db.transaction(async () => { (await assertRegisteredActor(ctx, actor)); if (path === '/me/notification-settings')
            return (await settings(ctx, actor.accountId)); if (path === '/me/notifications')
            return { items: (await ctx.db.all('SELECT id,kind,entity_id,title,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at DESC,id LIMIT 100', actor.accountId)) }; if (path === '/me/push-devices')
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
            await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE device_id=? AND status<>'accepted'",ctx.now(),id);
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
            await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',updated_at=? WHERE device_id=? AND status<>'accepted'",ctx.now(),prior.id);
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
        if (!previous && intent.key.includes(body.push_token as string)) throw new ApiError(400, 'push_token_in_operation_key');
        return execute(redacted);
    }));
}
export async function flushNotificationOutbox(ctx: AppContext): Promise<void> {
    for (const row of (await ctx.db.all<any>("SELECT j.*,n.kind FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.status IN('queued','dispatched','ambiguous') AND (j.dispatched_at IS NULL OR j.dispatched_at<=?) ORDER BY j.created_at LIMIT 25", ctx.now() - 60000))) {
        if (!(await permitted(ctx, row.account_id, row.kind, row.auth_epoch))) {
            (await ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?", row.notification_id));
            continue;
        }
        await ctx.env.PHOTO_JOBS.send({ category: 'notification', payload: { notification_id: row.notification_id } });
        (await ctx.db.run("UPDATE notification_jobs SET status='dispatched',dispatched_at=? WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')", ctx.now(), row.notification_id));
    }
}
export async function processNotificationJob(payload: unknown, ctx: AppContext): Promise<void> {
    const body = record(payload);
    if (Object.keys(body).some(key => key !== 'notification_id'))
        throw new ApiError(400, 'invalid_job');
    const id = uuid(body.notification_id);
    const job = (await ctx.db.one<any>('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?', id));
    if (!job || ['accepted', 'cancelled', 'inbox_only'].includes(job.status))
        return;
    if (!(await permitted(ctx, job.account_id, job.kind, job.auth_epoch))) {
        (await ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?", id));
        return;
    }
    const devices = (await ctx.db.all<any>("SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active' WHERE p.account_id=? AND p.active=1 ORDER BY p.id LIMIT 10", job.account_id));
    if (!devices.length) {
        (await ctx.db.run("UPDATE notification_jobs SET status='inbox_only' WHERE notification_id=?", id));
        return;
    }
    if (!ctx.env.PUSH_SERVICE)
        throw new ApiError(503, 'push_provider_unavailable');
    const activeDevice = async (device: any): Promise<boolean> => !!await ctx.db.one(
        "SELECT p.id FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active' WHERE p.id=? AND p.account_id=? AND p.active=1 AND p.token_hash=? AND p.platform=?",
        device.id, job.account_id, device.token_hash, device.platform);
    for (const device of devices) {
        const operation = 'notification:' + id + ':' + device.id, lease = crypto.randomUUID();
        const delivery = (await ctx.db.transaction(async () => {
            if (!(await permitted(ctx, job.account_id, job.kind, job.auth_epoch)))
                throw new ApiError(409, 'notification_authority_changed');
            (await ctx.db.run("INSERT OR IGNORE INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)", crypto.randomUUID(), id, device.id, operation, device.token_hash, ctx.now(), ctx.now()));
            const row = (await ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE operation_key=?', operation))!;
            if (['accepted', 'cancelled'].includes(row.status))
                return null;
            if (!await activeDevice(device)) {
                await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",ctx.now(),row.id);
                return null;
            }
            if (row.status === 'dispatching' && row.lease_until > ctx.now())
                throw new ApiError(503, 'push_delivery_in_progress');
            (await ctx.db.run("UPDATE notification_deliveries SET status='dispatching',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?", lease, ctx.now() + 60000, ctx.now(), row.id));
            return row;
        }));
        if (!delivery)
            continue;
        try {
            const readReceipt = async (response: Response): Promise<Record<string, any>> => {
                if(response.redirected||response.status>=300&&response.status<400)throw new ApiError(503,'push_provider_redirect_denied');
                // A pinned gateway can return a durable not_dispatched/ambiguous
                // disposition with HTTP 503. Parse its bound receipt before
                // deciding whether another network send is safe.
                const receipt=await jsonBody(response as unknown as Request,8192);
                if(receipt.operation_key!==operation||!['accepted','rejected','not_dispatched','ambiguous','preparing','dispatching','unknown'].includes(receipt.status))throw new ApiError(503,'push_receipt_unbound');
                return receipt;
            };
            const currentDispatch = async (): Promise<boolean> => ctx.db.transaction(async()=>{
                const current=await ctx.db.one<any>('SELECT status,lease_token FROM notification_deliveries WHERE id=?',delivery.id);
                if(!current||current.status==='cancelled'||current.lease_token!==lease)return false;
                if(!await activeDevice(device)||!await permitted(ctx,job.account_id,job.kind,job.auth_epoch)){
                    await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",ctx.now(),delivery.id);
                    return false;
                }
                return true;
            });
            const send = async (): Promise<Record<string,any>> => readReceipt(await ctx.env.PUSH_SERVICE!.fetch('https://push.internal/send', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: stable({ operation_key: operation, platform: device.platform, token: device.token_value, notification: { id, title: job.title, kind: job.kind, entity_id: job.entity_id } }) }));
            let receipt: Record<string,any>;
            if (delivery.status !== 'queued') {
                receipt = await readReceipt(await ctx.env.PUSH_SERVICE.fetch('https://push.internal/operations/' + encodeURIComponent(operation), { redirect: 'manual' }));
                if (receipt.status === 'not_dispatched') {
                    if(!await currentDispatch())continue;
                    // Only a durable pre-dispatch receipt permits the identical
                    // operation to be sent again. Provider rejection/ambiguity
                    // never grants resend authority. Rechecks and retries bound.
                    if(delivery.attempts>=5){
                        await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",ctx.now(),delivery.id,lease);
                        continue;
                    }
                    receipt=await send();
                }
            }
            else {
                if(!await currentDispatch())continue;
                receipt=await send();
            }
            if(receipt.status==='rejected'){
                if(typeof receipt.provider_code!=='string'||!receipt.provider_code||receipt.provider_code.length>160||typeof receipt.retryable!=='boolean'||typeof receipt.token_invalid!=='boolean')throw new ApiError(503,'push_receipt_unbound');
                await ctx.db.transaction(async()=>{
                    const current=await ctx.db.one<any>('SELECT lease_token FROM notification_deliveries WHERE id=?',delivery.id);
                    if(current?.lease_token!==lease)return;
                    await ctx.db.run("UPDATE notification_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",ctx.now(),delivery.id);
                    if(receipt.token_invalid)await ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE id=? AND account_id=? AND token_hash=?",ctx.now(),device.id,job.account_id,device.token_hash);
                });
                continue;
            }
            if (receipt.status !== 'accepted')throw new ApiError(503,'push_reconciliation_required');
            if (typeof receipt.provider_message_id !== 'string' || !receipt.provider_message_id || receipt.provider_message_id.length > 256)throw new ApiError(503, 'push_delivery_unconfirmed');
            (await ctx.db.transaction(async () => {
                const current = (await ctx.db.one<any>('SELECT * FROM notification_deliveries WHERE id=?', delivery.id)), active = await activeDevice(device);
                if (!current || current.lease_token !== lease || !active || !(await permitted(ctx, job.account_id, job.kind, job.auth_epoch)))
                    throw new ApiError(409, 'notification_authority_changed');
                (await ctx.db.run("UPDATE notification_deliveries SET status='accepted',provider_receipt=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?", receipt.provider_message_id, ctx.now(), delivery.id));
            }));
        }
        catch (error) {
            (await ctx.db.run("UPDATE notification_deliveries SET status='ambiguous',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='dispatching'", ctx.now(), delivery.id, lease));
            (await ctx.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')", id));
            throw error;
        }
    }
    await ctx.db.transaction(async()=>{
        if(!await permitted(ctx,job.account_id,job.kind,job.auth_epoch)){
            await ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?",id);return;
        }
        const rows=await ctx.db.all<{status:string}>('SELECT status FROM notification_deliveries WHERE notification_id=?',id);
        if(rows.every(row=>['accepted','cancelled'].includes(row.status)))await ctx.db.run('UPDATE notification_jobs SET status=? WHERE notification_id=?',rows.some(row=>row.status==='accepted')?'accepted':'inbox_only',id);
    });
    // No push device is an actual inbox-only state, never a delivery receipt.
}
export async function notificationPrivacyRows(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const rows = { notification_settings: (await settings(ctx, subject)), notifications: (await ctx.db.all('SELECT id,kind,title,created_at,read_at FROM notifications WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)), push_devices: (await ctx.db.all('SELECT id,platform,active,created_at,updated_at FROM push_devices WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)) };
    if (rows.notifications.length > 25000 || rows.push_devices.length > 25000)
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
export async function eraseNotificationSubject(db: Database, subject: string): Promise<void> {
    (await db.run('DELETE FROM notification_deliveries WHERE notification_id IN(SELECT id FROM notifications WHERE account_id=?) OR device_id IN(SELECT id FROM push_devices WHERE account_id=?)', subject, subject));
    (await db.run('DELETE FROM notification_jobs WHERE account_id=?', subject));
    (await db.run('DELETE FROM notifications WHERE account_id=?', subject));
    (await db.run('DELETE FROM push_devices WHERE account_id=?', subject));
    (await db.run('DELETE FROM notification_settings WHERE account_id=?', subject));
}
