import { ApiError, digest, stable, type Actor, type AppContext } from './types.ts';
import type { ManagedTokens } from './managed-auth-provider.ts';

export const managedAuthSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS managed_auth_bindings(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,local_session_id TEXT UNIQUE,predecessor_session_id TEXT UNIQUE,
      incarnation_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('signup','refresh')),
      state TEXT NOT NULL CHECK(state IN('creating','prepared','bound','superseded','ambiguous','retiring','retired')),
      creation_marker TEXT NOT NULL UNIQUE CHECK(length(creation_marker)=64),
      auth_user_id TEXT,auth_session_id TEXT,ciphertext TEXT,iv TEXT,tokens_expires_at INTEGER,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,retire_after INTEGER NOT NULL,
      logout_verified_at INTEGER,user_deleted_at INTEGER,failure_code TEXT,reconcile_page INTEGER NOT NULL DEFAULT 1 CHECK(reconcile_page BETWEEN 1 AND 1000000),
      CHECK((ciphertext IS NULL)=(iv IS NULL)),
      CHECK(state NOT IN('prepared','bound') OR(auth_user_id IS NOT NULL AND auth_session_id IS NOT NULL AND ciphertext IS NOT NULL AND tokens_expires_at IS NOT NULL)),
      CHECK(state<>'bound' OR local_session_id IS NOT NULL),
      CHECK(state<>'retired' OR ciphertext IS NULL))`,
    `CREATE INDEX IF NOT EXISTS managed_auth_account ON managed_auth_bindings(account_id,state,created_at)`,
    `CREATE INDEX IF NOT EXISTS managed_auth_identity ON managed_auth_bindings(auth_user_id,state)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS managed_auth_current_session ON managed_auth_bindings(auth_session_id) WHERE state='bound'`,
];
type Row = {
    id: string; account_id: string; local_session_id: string | null; predecessor_session_id: string | null;
    incarnation_id: string; operation: 'signup' | 'refresh'; state: string; creation_marker: string;
    auth_user_id: string | null; auth_session_id: string | null; ciphertext: string | null; iv: string | null;
    tokens_expires_at: number | null; created_at: number; updated_at: number; retire_after: number;
    logout_verified_at: number | null; user_deleted_at: number | null; failure_code: string | null; reconcile_page: number;
};
type Spec = { accountId: string; authMethod: string; predecessorSessionId?: string };
const encoder = new TextEncoder();
const unavailable = (code = 'managed_auth_unavailable'): never => { throw new ApiError(503, code); };
const secretString = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function secretBytes(value: string, maximum: number): Uint8Array {
    if (!value || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9_+/=-]+$/.test(value)) return unavailable('managed_auth_credential_invalid');
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); }
    catch { return unavailable('managed_auth_credential_invalid'); }
    if (bytes.length > maximum) { bytes.fill(0); return unavailable('managed_auth_credential_invalid'); }
    return bytes;
}
export function managedAuthEnabled(ctx: AppContext): boolean {
    if (ctx.env.MANAGED_AUTH && ctx.env.MANAGED_AUTH_ENCRYPTION_KEY) return true;
    // Test fixtures without an Auth server retain their explicit isolated port.
    // There is no production/development fallback to custom-only identities.
    if (ctx.env.APP_ENV === 'test' && !ctx.env.MANAGED_AUTH && !ctx.env.MANAGED_AUTH_ENCRYPTION_KEY) return false;
    return unavailable('managed_auth_configuration_required');
}
function externalBoundary(ctx: AppContext): void {
    if (ctx.db.inTransaction?.()) return unavailable('managed_auth_transaction_boundary');
}
export async function validateManagedAuthConfiguration(ctx: AppContext): Promise<void> {
    if (managedAuthEnabled(ctx)) await key(ctx);
}
/** Provider availability does not establish the local database read boundary.
 * Readiness requires both restricted predicates and rejects broad Auth grants. */
export async function validateManagedAuthDatabase(ctx: AppContext): Promise<void> {
    const functions = await ctx.db.one<{ count: number; ready: boolean | null }>(`SELECT count(*) AS count,bool_and(
      p.prosecdef AND p.proisstrict AND p.provolatile='v' AND p.prorettype='boolean'::regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname='lovelies_api')
      AND has_function_privilege('lovelies_api',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AS ready
      FROM pg_proc p WHERE p.oid IN(
        to_regprocedure('lovelies_private.managed_auth_session_current(text,text,bigint)'),
        to_regprocedure('lovelies_private.managed_auth_user_absent(text)'))`);
    if (Number(functions?.count) !== 2 || functions?.ready !== true) return unavailable('managed_auth_database_boundary_invalid');
    const grants = await ctx.db.one<{ count: number; exposed: boolean | null }>(`SELECT count(*) AS count,bool_or(
      has_table_privilege('lovelies_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege('lovelies_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) AS exposed
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname IN('users','sessions') AND c.relkind IN('r','p')`);
    if (Number(grants?.count) !== 2 || grants?.exposed !== false) return unavailable('managed_auth_database_boundary_invalid');
    const sentinel = '00000000-0000-0000-0000-000000000000';
    const probes = await ctx.db.one<{ current: boolean; absent: boolean }>(`SELECT
      managed_auth_session_current(?,?,?) AS current,managed_auth_user_absent(?) AS absent`, sentinel, sentinel, ctx.now(), sentinel);
    if (typeof probes?.current !== 'boolean' || typeof probes?.absent !== 'boolean') return unavailable('managed_auth_database_boundary_invalid');
}
async function key(ctx: AppContext): Promise<CryptoKey> {
    const configured = ctx.env.MANAGED_AUTH_ENCRYPTION_KEY;
    if (!configured || configured === ctx.env.AUTH_SIGNING_SECRET || configured === ctx.env.MEDIA_SIGNING_SECRET)
        return unavailable('managed_auth_encryption_configuration');
    const bytes = secretBytes(configured, 32);
    try {
        if (bytes.length !== 32) return unavailable('managed_auth_encryption_configuration');
        for (const signingSecret of [ctx.env.AUTH_SIGNING_SECRET, ctx.env.MEDIA_SIGNING_SECRET]) {
            const signingBytes = encoder.encode(signingSecret ?? '');
            try {
                if (signingBytes.length === bytes.length && bytes.every((value, index) => value === signingBytes[index]))
                    return unavailable('managed_auth_encryption_configuration');
            } finally { signingBytes.fill(0); }
        }
        return await crypto.subtle.importKey('raw', new Uint8Array(bytes).buffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } finally { bytes.fill(0); }
}
const aad = (row: Pick<Row, 'id' | 'account_id' | 'incarnation_id' | 'auth_user_id' | 'auth_session_id'>) =>
    encoder.encode(stable({ protocol: 'lovelies-managed-auth-custody-v1', ...row }));
async function encrypt(tokens: ManagedTokens, row: Row, ctx: AppContext): Promise<{ ciphertext: string; iv: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12)), bytes = encoder.encode(JSON.stringify(tokens));
    try { return { ciphertext: secretString(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: aad({ id: row.id, account_id: row.account_id, incarnation_id: row.incarnation_id,
            auth_user_id: tokens.user_id, auth_session_id: tokens.session_id }) }, await key(ctx), bytes))), iv: secretString(iv) }; }
    finally { bytes.fill(0); }
}
async function decrypt(row: Row, ctx: AppContext): Promise<ManagedTokens> {
    if (!row.ciphertext || !row.iv || !row.auth_user_id || !row.auth_session_id) return unavailable('managed_auth_credential_unavailable');
    const iv = secretBytes(row.iv, 12), ciphertext = secretBytes(row.ciphertext, 24_576);
    let bytes: Uint8Array | undefined;
    try {
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv).buffer,
            additionalData: aad({ id: row.id, account_id: row.account_id, incarnation_id: row.incarnation_id,
                auth_user_id: row.auth_user_id, auth_session_id: row.auth_session_id }) }, await key(ctx), new Uint8Array(ciphertext).buffer));
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (Object.keys(value).sort().join(',') !== 'access_token,expires_at,refresh_token,session_id,user_id' ||
            value.user_id !== row.auth_user_id || value.session_id !== row.auth_session_id || value.expires_at !== row.tokens_expires_at ||
            typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') return unavailable('managed_auth_credential_invalid');
        return value;
    } catch { return unavailable('managed_auth_credential_invalid'); }
    finally { bytes?.fill(0); iv.fill(0); ciphertext.fill(0); }
}
async function incarnation(ctx: AppContext): Promise<string> {
    const row = await ctx.db.one<{ incarnation_id: string }>('SELECT incarnation_id FROM restore_control WHERE singleton=1');
    if (!row) return unavailable('managed_auth_restore_binding_required');
    return row.incarnation_id;
}
async function serverSession(ctx: AppContext, row: Row): Promise<boolean> {
    if (!row.auth_user_id || !row.auth_session_id) return false;
    const current = await ctx.db.one<{ current: boolean }>('SELECT managed_auth_session_current(?,?,?) AS current', row.auth_user_id, row.auth_session_id, ctx.now());
    return current?.current === true;
}
async function prepared(row: Row, account: string, expiresAt: number, ctx: AppContext): Promise<string> {
    if (row.account_id !== account || row.state !== 'prepared' || row.incarnation_id !== await incarnation(ctx) ||
        row.tokens_expires_at === null || row.tokens_expires_at < expiresAt || !await serverSession(ctx, row))
        return unavailable('managed_auth_preparation_unavailable');
    return row.id;
}

/** Reserve durably, call GoTrue outside the application transaction, then store
 * the encrypted exact result. An uncertain reply leaves an explicit unresolved
 * attempt. Retrying never invents a positive result or replays a refresh token. */
export async function prepareManagedSession(spec: Spec, expiresAt: number, refreshExpiresAt: number, ctx: AppContext): Promise<string | undefined> {
    if (!managedAuthEnabled(ctx)) return undefined;
    externalBoundary(ctx); await key(ctx);
    const selected = await ctx.db.transaction(async () => {
        const owner = await ctx.db.one<{ disabled_at: number | null }>('SELECT disabled_at FROM accounts WHERE id=?', spec.accountId);
        if (owner?.disabled_at !== null && owner !== null || !owner && spec.authMethod !== 'anonymous') throw new ApiError(401, 'account_disabled');
        const lineage = await incarnation(ctx);
        if (spec.predecessorSessionId) {
            const existing = await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE predecessor_session_id=?', spec.predecessorSessionId);
            if (existing) return { row: existing, predecessor: null, existing: true };
        }
        const predecessor = spec.predecessorSessionId ? await ctx.db.one<Row>("SELECT * FROM managed_auth_bindings WHERE local_session_id=? AND account_id=? AND state='bound'", spec.predecessorSessionId, spec.accountId) : null;
        if (spec.predecessorSessionId && (!predecessor || predecessor.incarnation_id !== lineage || !await serverSession(ctx, predecessor)))
            throw new ApiError(401, 'managed_auth_session_invalid');
        const id = crypto.randomUUID(), marker = await digest(crypto.getRandomValues(new Uint8Array(32)));
        await ctx.db.run(`INSERT INTO managed_auth_bindings(id,account_id,predecessor_session_id,incarnation_id,operation,state,creation_marker,
            auth_user_id,auth_session_id,created_at,updated_at,retire_after) VALUES(?,?,?,?,?,'creating',?,?,?,?,?,?)`,
            id, spec.accountId, spec.predecessorSessionId ?? null, lineage, predecessor ? 'refresh' : 'signup', marker,
            predecessor?.auth_user_id ?? null, predecessor?.auth_session_id ?? null, ctx.now(), ctx.now(), ctx.now() + 60_000);
        return { row: (await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', id))!, predecessor, existing: false };
    });
    if (selected.existing) return ctx.db.read(() => prepared(selected.row, spec.accountId, expiresAt, ctx));
    let tokens: ManagedTokens;
    try {
        externalBoundary(ctx);
        tokens = selected.predecessor ? await ctx.env.MANAGED_AUTH!.refresh((await decrypt(selected.predecessor, ctx)).refresh_token) :
            await ctx.env.MANAGED_AUTH!.signUp(selected.row.creation_marker);
        if (selected.predecessor && (tokens.user_id !== selected.predecessor.auth_user_id || tokens.session_id !== selected.predecessor.auth_session_id))
            return unavailable('managed_auth_refresh_identity_changed');
        const encrypted = await encrypt(tokens, selected.row, ctx);
        await ctx.db.transaction(async () => {
            const current = await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', selected.row.id);
            if (!current || !['creating', 'retiring'].includes(current.state)) return unavailable('managed_auth_preparation_changed');
            const owner = await ctx.db.one<{ disabled_at: number | null }>('SELECT disabled_at FROM accounts WHERE id=?', spec.accountId);
            if (await ctx.db.one('SELECT id FROM managed_auth_bindings WHERE auth_user_id=? AND account_id<>? LIMIT 1', tokens.user_id, spec.accountId))
                return unavailable('managed_auth_identity_mapping_conflict');
            const retiring = current.state === 'retiring' || owner?.disabled_at != null || current.incarnation_id !== await incarnation(ctx);
            await ctx.db.run(`UPDATE managed_auth_bindings SET auth_user_id=?,auth_session_id=?,ciphertext=?,iv=?,tokens_expires_at=?,state=?,updated_at=? WHERE id=?`,
                tokens.user_id, tokens.session_id, encrypted.ciphertext, encrypted.iv, tokens.expires_at, retiring ? 'retiring' : 'prepared', ctx.now(), current.id);
        });
    } catch (error) {
        await ctx.db.transaction(() => ctx.db.run("UPDATE managed_auth_bindings SET state=CASE WHEN state='creating' THEN 'ambiguous' ELSE state END,failure_code='managed_auth_result_unresolved',updated_at=? WHERE id=?", ctx.now(), selected.row.id));
        throw error instanceof ApiError ? error : new ApiError(503, 'managed_auth_result_unresolved');
    }
    return ctx.db.read(async () => prepared((await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', selected.row.id))!, spec.accountId, expiresAt, ctx));
}

/** Caller has already inserted and revalidated its exact local face/device
 * authority in this transaction. A managed identity alone never upgrades it. */
export async function bindManagedSession(bindingId: string | undefined, sessionId: string, accountId: string, ctx: AppContext): Promise<void> {
    if (!managedAuthEnabled(ctx)) return;
    const row = bindingId && await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', bindingId);
    const session = await ctx.db.one<{ expires_at: number; refresh_expires_at: number }>('SELECT expires_at,refresh_expires_at FROM sessions WHERE id=? AND account_id=?', sessionId, accountId);
    if (!row || !session) return unavailable('managed_auth_binding_required');
    await prepared(row, accountId, session.expires_at, ctx);
    if (await ctx.db.one("SELECT id FROM managed_auth_bindings WHERE auth_user_id=? AND state='retiring' LIMIT 1", row.auth_user_id))
        throw new ApiError(401, 'managed_auth_identity_retired');
    if (row.predecessor_session_id) {
        const previous = await ctx.db.one<{ revoked_at: number | null }>('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?', row.predecessor_session_id, accountId);
        if (!previous || previous.revoked_at === null) return unavailable('managed_auth_predecessor_not_retired');
        await ctx.db.run("UPDATE managed_auth_bindings SET state='superseded',ciphertext=NULL,iv=NULL,updated_at=? WHERE local_session_id=? AND account_id=? AND state='bound'", ctx.now(), row.predecessor_session_id, accountId);
    }
    await ctx.db.run("UPDATE managed_auth_bindings SET state='bound',local_session_id=?,retire_after=?,updated_at=? WHERE id=? AND state='prepared'", sessionId, session.refresh_expires_at, ctx.now(), row.id);
}
export async function assertManagedSession(actor: Pick<Actor, 'accountId' | 'sessionId'>, ctx: AppContext, allowExpired = false): Promise<void> {
    if (!managedAuthEnabled(ctx)) return;
    const row = await ctx.db.one<Row>("SELECT * FROM managed_auth_bindings WHERE local_session_id=? AND account_id=? AND state='bound'", actor.sessionId, actor.accountId);
    if (!row || row.incarnation_id !== await incarnation(ctx) || !allowExpired && (row.tokens_expires_at ?? 0) <= ctx.now() || !await serverSession(ctx, row))
        throw new ApiError(401, 'managed_auth_session_invalid');
}
async function localBindingCurrent(ctx: AppContext, row: Row): Promise<boolean> {
    if (row.state !== 'bound' || row.incarnation_id !== await incarnation(ctx) || !row.local_session_id) return false;
    return !!await ctx.db.one(`SELECT s.id FROM sessions s JOIN accounts a ON a.id=s.account_id
      WHERE s.id=? AND s.account_id=? AND s.revoked_at IS NULL AND s.refresh_consumed_at IS NULL AND s.refresh_expires_at>?
      AND a.disabled_at IS NULL AND s.auth_epoch=a.auth_epoch AND s.auth_method=a.identity_state
      AND (s.auth_method='anonymous' OR EXISTS(SELECT 1 FROM auth_devices d WHERE d.id=s.device_id AND d.account_id=s.account_id AND d.revision=s.device_revision AND d.status='active'))`, row.local_session_id, row.account_id, ctx.now());
}

async function retireIdentity(ctx: AppContext, candidate: Row): Promise<boolean> {
    const selected = await ctx.db.transaction(async () => {
        if (!candidate.auth_user_id) return null;
        const rows = await ctx.db.all<Row>('SELECT * FROM managed_auth_bindings WHERE auth_user_id=? ORDER BY created_at DESC,id', candidate.auth_user_id);
        for (const row of rows) {
            if (await localBindingCurrent(ctx, row)) return null;
            if (['creating','prepared'].includes(row.state) && row.retire_after > ctx.now() && row.incarnation_id === await incarnation(ctx) &&
                !await ctx.db.one('SELECT id FROM accounts WHERE id=? AND disabled_at IS NOT NULL', row.account_id)) return null;
        }
        await ctx.db.run("UPDATE managed_auth_bindings SET state='retiring',updated_at=? WHERE auth_user_id=? AND user_deleted_at IS NULL", ctx.now(), candidate.auth_user_id);
        return rows.find(row => row.ciphertext !== null) ?? rows[0];
    });
    if (!selected) return false;
    externalBoundary(ctx);
    // Expired JWTs may prevent logout. Require both supported provider deletion
    // evidence and physical absence in the application deployment's Auth DB.
    if (selected.ciphertext) try {
        await ctx.env.MANAGED_AUTH!.signOut((await decrypt(selected, ctx)).access_token);
        await ctx.db.run('UPDATE managed_auth_bindings SET logout_verified_at=? WHERE auth_user_id=?', ctx.now(), selected.auth_user_id);
    } catch { /* Keep deletion pending until the independent absence check. */ }
    await ctx.env.MANAGED_AUTH!.deleteUser(selected.auth_user_id!);
    if (await ctx.env.MANAGED_AUTH!.userExists(selected.auth_user_id!)) return unavailable('managed_auth_delete_unconfirmed');
    await ctx.db.transaction(async () => {
        const local = await ctx.db.one<{ absent: boolean }>('SELECT managed_auth_user_absent(?) AS absent', selected.auth_user_id);
        if (local?.absent !== true) return unavailable('managed_auth_delete_unconfirmed');
        await ctx.db.run("UPDATE managed_auth_bindings SET state='retired',ciphertext=NULL,iv=NULL,user_deleted_at=?,failure_code=NULL,updated_at=? WHERE auth_user_id=? AND state='retiring'", ctx.now(), ctx.now(), selected.auth_user_id);
    });
    return true;
}
async function reconcileSignupForRetirement(ctx: AppContext, row: Row): Promise<Row | null> {
    if (row.auth_user_id || row.operation !== 'signup' || row.created_at + 60_000 > ctx.now()) return null;
    externalBoundary(ctx);
    const result = await ctx.env.MANAGED_AUTH!.signupCandidates(row.creation_marker, row.created_at, row.reconcile_page);
    if (result.userIds.length > 1 || !Number.isSafeInteger(result.nextPage) || result.nextPage < 1 || result.nextPage > 1_000_000)
        return unavailable('managed_auth_lookup_ambiguous');
    return ctx.db.transaction(async () => {
        const current = await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', row.id);
        if (!current || current.auth_user_id || current.creation_marker !== row.creation_marker ||
            !['creating', 'ambiguous', 'retiring'].includes(current.state)) return null;
        const userId = result.userIds[0];
        if (userId) {
            // A private, random marker locates the orphan created by this
            // already-retired attempt. It cannot reconstruct a token, turn a
            // user into a face-registered account, or authorize any app action.
            // Refuse even cleanup if this identity belongs to another attempt.
            if (await ctx.db.one('SELECT id FROM managed_auth_bindings WHERE auth_user_id=? AND id<>? LIMIT 1', userId, row.id))
                return unavailable('managed_auth_identity_mapping_conflict');
            await ctx.db.run("UPDATE managed_auth_bindings SET auth_user_id=?,state='retiring',failure_code=NULL,updated_at=? WHERE id=?", userId, ctx.now(), row.id);
            return await ctx.db.one<Row>('SELECT * FROM managed_auth_bindings WHERE id=?', row.id);
        }
        await ctx.db.run("UPDATE managed_auth_bindings SET state='ambiguous',reconcile_page=?,failure_code='managed_auth_signup_unresolved',updated_at=? WHERE id=?", result.nextPage, ctx.now(), row.id);
        return null;
    });
}
export async function maintainManagedAuth(ctx: AppContext, maximum = 8, accountId?: string): Promise<{ retired: number; unresolved: number }> {
    if (!managedAuthEnabled(ctx)) return { retired: 0, unresolved: 0 };
    externalBoundary(ctx);
    const rows = await ctx.db.all<Row>(`SELECT * FROM managed_auth_bindings WHERE user_deleted_at IS NULL
      ${accountId === undefined ? '' : 'AND account_id=?'} ORDER BY updated_at,id LIMIT ?`, ...(accountId === undefined ? [] : [accountId]), maximum);
    let retired = 0;
    const seen = new Set<string>();
    for (const row of rows) {
        if (row.auth_user_id && !seen.has(row.auth_user_id)) {
            seen.add(row.auth_user_id);
            try { if (await retireIdentity(ctx, row)) retired++; }
            catch (error) {
                await ctx.db.run("UPDATE managed_auth_bindings SET failure_code='managed_auth_cleanup_unresolved',updated_at=? WHERE auth_user_id=? AND user_deleted_at IS NULL", ctx.now(), row.auth_user_id);
                if (!(error instanceof ApiError) || !error.code.startsWith('managed_auth_')) throw error;
            }
        } else if (!row.auth_user_id && row.created_at + 60_000 <= ctx.now()) {
            try {
                const found = await reconcileSignupForRetirement(ctx, row);
                if (found && await retireIdentity(ctx, found)) retired++;
            } catch (error) {
                await ctx.db.run("UPDATE managed_auth_bindings SET state='ambiguous',failure_code='managed_auth_signup_unresolved',updated_at=? WHERE id=? AND auth_user_id IS NULL", ctx.now(), row.id);
                if (!(error instanceof ApiError) || !error.code.startsWith('managed_auth_')) throw error;
            }
        }
        // Fair examination: a live identity cannot monopolize bounded cleanup.
        await ctx.db.run('UPDATE managed_auth_bindings SET updated_at=? WHERE id=?', Math.max(ctx.now(), row.updated_at + 1), row.id);
    }
    const count = await ctx.db.one<{ n: number }>(`SELECT count(*) n FROM managed_auth_bindings WHERE state IN('ambiguous','retiring') ${accountId === undefined ? '' : 'AND account_id=?'}`, ...(accountId === undefined ? [] : [accountId]));
    return { retired, unresolved: Number(count?.n ?? 0) };
}
/** Approved deletion admits a deny-only local transition before network work.
 * Its caller supplies the existing exact execution/hold guard. Completion is
 * forbidden until every managed user has independently verified absence. */
export async function retireManagedAccount(ctx: AppContext, accountId: string, authorize: () => Promise<void>): Promise<void> {
    if (!managedAuthEnabled(ctx)) return;
    externalBoundary(ctx);
    await ctx.db.transaction(async () => {
        await authorize();
        await ctx.db.run('UPDATE accounts SET disabled_at=coalesce(disabled_at,?) WHERE id=?', ctx.now(), accountId);
        await ctx.db.run('UPDATE sessions SET revoked_at=coalesce(revoked_at,?),refresh_consumed_at=coalesce(refresh_consumed_at,?) WHERE account_id=?', ctx.now(), ctx.now(), accountId);
        await ctx.db.run("UPDATE managed_auth_bindings SET state='retiring',updated_at=? WHERE account_id=? AND user_deleted_at IS NULL", ctx.now(), accountId);
    });
    await maintainManagedAuth(ctx, 16, accountId);
    await assertManagedAccountRetired(ctx, accountId);
}
export async function assertManagedAccountRetired(ctx: AppContext, accountId: string): Promise<void> {
    // This is a pure custody check, also used by quarantined restore replay.
    // Provider cleanup must finish outside the surrounding SQL transaction.
    if (await ctx.db.one('SELECT id FROM managed_auth_bindings WHERE account_id=? AND user_deleted_at IS NULL LIMIT 1', accountId))
        return unavailable('managed_auth_account_cleanup_required');
}
