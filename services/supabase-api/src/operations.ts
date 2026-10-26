import { assertAudienceCapability } from './audience.ts';
import { ApiError, digest, stable, type Actor, type AppContext } from './types.ts';
import { assertEnrollmentActor, assertPrivacyActor } from './auth.ts';
import { restoreAllocationID, restoreOperationID, type RestoreTransactionScope } from './restore-transaction.ts';
export type PreparedOperation = Readonly<{
    key: string;
    action: string;
    source: string;
    hash: string;
    payloadJson: string;
}>;
// Prepared inputs are always JSON objects. JSON null is reserved for a retired
// receipt, while its original action/hash/key continue preventing re-execution.
export const retiredOperationInput = 'null';
export const retiredOperationResponse = stable({ protocol: 'lovelies-operation-retired-v1', status: 'retired' });
export function assertOperationReceiptAvailable(row: { payload_json: string; response_json: string }): void {
    if (row.payload_json !== retiredOperationInput && row.response_json !== retiredOperationResponse) return;
    if (row.payload_json !== retiredOperationInput || row.response_json !== retiredOperationResponse)
        throw new ApiError(503, 'operation_receipt_unavailable');
    throw new ApiError(410, 'operation_receipt_retired');
}
/** Anonymous credentials can enroll, but do not authorize private data mutation
 * or release. The durable row is checked in addition to the signed credential. */
export async function assertRegisteredActor(ctx: AppContext, actor: Actor): Promise<void> {
    (await ctx.assertActor(actor));
    const account = (await ctx.db.one<{
        identity_state: string;
        disabled_at: number | null;
    }>('SELECT identity_state,disabled_at FROM accounts WHERE id=?', actor.accountId));
    if (actor.authMethod !== 'registered_face' || account?.identity_state !== 'registered_face' || account.disabled_at !== null) {
        throw new ApiError(403, 'registered_face_required');
    }
}
/** Register before a private Supabase Storage PUT. Erasure cannot finish while a writer is
 * unresolved; current-session guards still control metadata publication. */
async function mediaWrite(ctx: AppContext, actor: Actor, bucket: 'PHOTOS' | 'QUARANTINE' | 'PRIVACY_EXPORTS', objectKey: string, enrollment: boolean): Promise<string> {
    return (await ctx.db.transaction(async () => {
        if (enrollment) {
            (await assertEnrollmentActor(actor, ctx));
            await assertAudienceCapability(ctx, actor.accountId, 'face_authentication');
        }
        else
            (await assertRegisteredActor(ctx, actor));
        const account = (await ctx.db.one<{
            disabled_at: number | null;
        }>('SELECT disabled_at FROM accounts WHERE id=?', actor.accountId));
        if (!account || account.disabled_at !== null)
            throw new ApiError(401, 'account_disabled');
        const id = crypto.randomUUID();
        (await ctx.db.run('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)', id, actor.accountId, bucket, objectKey, 'pending', ctx.now()));
        return id;
    }));
}
export async function beginMediaWrite(ctx: AppContext, actor: Actor, bucket: 'PHOTOS' | 'QUARANTINE' | 'PRIVACY_EXPORTS', objectKey: string): Promise<string> {
    return (await mediaWrite(ctx, actor, bucket, objectKey, false));
}
/** Weaker admission is confined to the enrollment module's private captures
 * and derived templates; it does not authorize gallery/share/privacy reads. */
export async function beginEnrollmentMediaWrite(ctx: AppContext, actor: Actor, bucket: 'PHOTOS' | 'QUARANTINE', objectKey: string): Promise<string> {
    return (await mediaWrite(ctx, actor, bucket, objectKey, true));
}
/** Face login has a signed, bound challenge before it has a session. The face
 * module must also check exact device/profile/consent and signature. */
export async function beginFaceChallengeMediaWrite(ctx: AppContext, challengeId: string, bucket: 'PHOTOS' | 'QUARANTINE', objectKey: string, guard?: () => void | Promise<void>): Promise<string> {
    return (await ctx.db.transaction(async () => {
        const challenge = (await ctx.db.one<{
            account_id: string;
            auth_epoch: number;
            status: string;
            used_at: number | null;
            expires_at: number;
        }>('SELECT account_id,auth_epoch,status,used_at,expires_at FROM auth_challenges WHERE id=?', challengeId));
        const account = challenge && (await ctx.db.one<{
            auth_epoch: number;
            disabled_at: number | null;
        }>('SELECT auth_epoch,disabled_at FROM accounts WHERE id=?', challenge.account_id));
        if (!challenge || !account || account.disabled_at !== null || challenge.auth_epoch !== account.auth_epoch ||
            !['pending', 'verifying'].includes(challenge.status) || challenge.used_at !== null || challenge.expires_at <= ctx.now()) {
            throw new ApiError(401, 'face_challenge_unavailable');
        }
        await assertAudienceCapability(ctx, challenge.account_id, 'face_authentication');
        if (guard) {
            await guard();
        }
        const id = crypto.randomUUID();
        (await ctx.db.run('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)', id, challenge.account_id, bucket, objectKey, 'pending', ctx.now()));
        return id;
    }));
}
/** Call only after the actual PUT promise settles, including rejection. This
 * durable completion marker does not grant access or bypass revocation. */
export async function settleMediaWrite(ctx: AppContext, id: string): Promise<void> {
    (await ctx.db.transaction(async () => (await ctx.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", ctx.now(), id))));
}
export async function prepareOperation(action: string, payload: Record<string, unknown>, source = 'personal'): Promise<PreparedOperation> {
    const key = payload.operation_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
        throw new ApiError(400, 'operation_key_required');
    }
    if (!action || action.length > 128 || !/^[a-zA-Z0-9._:-]{1,128}$/.test(source)) {
        throw new ApiError(400, 'operation_scope_invalid');
    }
    const payloadJson = stable(payload);
    if (new TextEncoder().encode(payloadJson).byteLength > 1024 * 1024)
        throw new ApiError(413, 'request_too_large');
    const hash = await digest(stable({ action, source, payload }));
    return Object.freeze({ key, action, source, hash, payloadJson });
}
function relatedSubjects(value: unknown, subjects: Set<string>, parent = ''): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === 'string' && ['selected_recipient_ids', 'recipient_ids'].includes(parent))
                subjects.add(item.toLowerCase());
            else
                relatedSubjects(item, subjects, parent);
        }
    }
    else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' && (['recipient_id', 'sender_id', 'owner_id', 'subject_user_id', 'subject_id', 'account_id'].includes(key) || key === 'id' && parent === 'recipients'))
                subjects.add(item.toLowerCase());
            else
                relatedSubjects(item, subjects, key);
        }
    }
}
type OperationAllocations = Readonly<Record<string, string>>;
type AllocationFactory = (operationID: string) => OperationAllocations | Promise<OperationAllocations>;
/** Uses the same durable key after ambiguity. The callback and all authorizing
 * reads/writes are awaited inside one PostgreSQL transaction. */
async function executeAuthorizedOperation<T extends Record<string, unknown>>(ctx: AppContext, actor: Actor, intent: PreparedOperation, callback: (restore: RestoreTransactionScope, allocations: OperationAllocations) => T | Promise<T>, subjectIds: readonly string[], assertAuthority: () => void | Promise<void>, allocate?: AllocationFactory): Promise<T> {
    return (await ctx.db.transaction(async restore => {
        (await assertAuthority());
        const previous = (await ctx.db.one<{
            action: string;
            payload_hash: string;
            payload_json: string;
            response_json: string;
        }>('SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, intent.source, intent.key));
        if (previous) {
            if (previous.action !== intent.action || previous.payload_hash !== intent.hash) {
                throw new ApiError(409, 'operation_key_conflict');
            }
            if (previous.payload_json === retiredOperationInput || previous.response_json === retiredOperationResponse) {
                (await assertAuthority());
                assertOperationReceiptAvailable(previous);
            }
            if (previous.payload_json !== intent.payloadJson) throw new ApiError(409, 'operation_key_conflict');
            (await assertAuthority());
            return JSON.parse(previous.response_json) as T;
        }
        // A SQL receipt retry above never re-prepares its committed independent
        // operation. New callbacks bind the logical key before collecting facts.
        const operationID = await restoreOperationID(actor.accountId, intent.source, intent.key);
        const allocations: OperationAllocations = Object.freeze({ ...(allocate ? await allocate(operationID) : {}) });
        restore.operation({ operation_id: operationID, input_hash: intent.hash, allocations });
        const result = await callback(restore, allocations);
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as {
            then?: unknown;
        }).then === 'function') {
            throw new ApiError(500, 'invalid_operation_result');
        }
        (await assertAuthority());
        const responseJson = stable(result);
        if (new TextEncoder().encode(intent.payloadJson + responseJson).byteLength > 1900000)
            throw new ApiError(500, 'operation_result_too_large');
        (await ctx.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', actor.accountId, intent.source, intent.key, intent.action, intent.hash, intent.payloadJson, responseJson, ctx.now()));
        const subjects = new Set([actor.accountId, ...subjectIds]);
        relatedSubjects(JSON.parse(intent.payloadJson), subjects);
        relatedSubjects(result, subjects);
        for (const subject of subjects) {
            if ((await ctx.db.one('SELECT id FROM accounts WHERE id=?', subject))) {
                (await ctx.db.run('INSERT INTO operation_subjects(actor_id,source,operation_key,subject_id) VALUES(?,?,?,?)', actor.accountId, intent.source, intent.key, subject));
            }
        }
        return JSON.parse(responseJson) as T;
    }));
}
/** Protected product operations retain registered-face authority. */
export async function executeOperation<T extends Record<string, unknown>>(ctx: AppContext, actor: Actor, intent: PreparedOperation, callback: (restore: RestoreTransactionScope) => T | Promise<T>, subjectIds: readonly string[] = []): Promise<T> {
    return (await executeAuthorizedOperation(ctx, actor, intent, callback, subjectIds, async () => (await assertRegisteredActor(ctx, actor))));
}
/** Anonymous admission is confined to deleting the actor's own account. The
 * fixed allocation is created only for a new callback, never for a SQL receipt. */
export async function executeAccountDeletionOperation<T extends Record<string, unknown>>(ctx: AppContext, actor: Actor, intent: PreparedOperation, callback: (restore: RestoreTransactionScope, requestID: string) => T | Promise<T>): Promise<T> {
    if (intent.action !== 'privacy.request.delete' || intent.source !== 'privacy')
        throw new ApiError(400, 'operation_scope_invalid');
    return (await executeAuthorizedOperation(ctx, actor, intent,
        (restore, allocations) => callback(restore, allocations.id_0), [],
        async () => (await assertPrivacyActor(actor, ctx)),
        async operationID => ({ id_0: await restoreAllocationID(operationID, 'id_0') })));
}

/** Restricted account controls never grant a product capability. */
export async function executeRestrictedOperation<T extends Record<string, unknown>>(ctx: AppContext, actor: Actor, intent: PreparedOperation, callback: (restore: RestoreTransactionScope) => T | Promise<T>, subjectIds: readonly string[] = []): Promise<T> {
    if (!['audience', 'guardian', 'privacy'].includes(intent.source)) throw new ApiError(400, 'operation_scope_invalid');
    return executeAuthorizedOperation(ctx, actor, intent, callback, subjectIds, () => assertPrivacyActor(actor, ctx));
}
