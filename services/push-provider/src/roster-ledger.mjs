/** Complete independent push admission. No token, notification text or provider
 * private key enters this store. Immutable SQL evidence and a checked KV binding
 * share the Durable Object transaction; a missing binding is never recreated. */
import { authenticateLedger, ledgerError, ledgerResponse, loadBinding, PushLedgerError, PUSH_LEDGER_PROJECT, validateOutcome } from './durable-ledger.mjs';
import { canonical, exact, HASH, UUID, validatePlan, sha256, PUSH_RECEIPT_V2, PUSH_ROSTER_PROTOCOL } from './push-plan.mjs';
export const ROSTER_BINDING = 'push-roster-binding:v2';
export const ROSTER_BODY_LIMIT = 16384;
export const ROSTER_REPLY_LIMIT = 32768;
const OPERATION = /^notification:([0-9a-f-]{36}):([0-9a-f-]{36})$/;
const tables = Object.freeze({ plans: 'push_roster_plans_v2', entries: 'push_roster_entries_v2', intents: 'push_roster_intents_v2',
    outcomes: 'push_roster_outcomes_v2', subjects: 'push_roster_subject_retirements_v2', retired_plans: 'push_roster_plan_retirements_v2',
    generations: 'push_roster_generations_v2', retired_generations: 'push_roster_generation_retirements_v2' });
const claims = 'push_roster_claims_v2';
const fail = (status, code) => { throw new PushLedgerError(status, code); };
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const q = async (sql, statement, ...values) => { try {
    const cursor = await sql.exec(statement, ...values);
    return await cursor.toArray();
}
catch {
    fail(503, 'push_roster_integrity_failed');
} };
const fields = ['version', 'protocol', 'project_id', 'ledger_id', 'bootstrap_id', 'provider_generation', 'state', 'reason', 'created_at', 'last_at', 'revision', ...Object.keys(tables), 'binding_sha256'];
const reasons = ['ledger_recovery_required', 'provider_generation_retirement', 'storage_integrity_unconfirmed'];
const envelope = (binding, result) => ({ protocol: PUSH_ROSTER_PROTOCOL, project_id: PUSH_LEDGER_PROJECT, ledger_id: binding.ledger_id,
    ledger_bootstrap_id: binding.bootstrap_id, control: control(binding), ...(result === undefined ? {} : { result }) });
function control(b) {
    return { provider_generation: b.provider_generation, state: b.state, reason: b.reason, revision: b.revision,
        plans: b.plans, attempts: b.entries, started: b.intents, settled: b.outcomes, retired_subjects: b.subjects };
}
async function sealed(fields) { return { ...fields, binding_sha256: await sha256(canonical(fields)) }; }
async function storeControl(txn, binding, at, increments = {}) {
    const { binding_sha256, ...next } = binding;
    for (const [name, n] of Object.entries(increments)) {
        if (!Object.hasOwn(tables, name) || !integer(n))
            fail(503, 'push_roster_integrity_failed');
        next[name] += n;
    }
    next.revision++;
    next.last_at = at;
    if (!integer(next.revision) || Object.keys(tables).some(name => !integer(next[name])))
        fail(503, 'push_roster_sequence_exhausted');
    const result = await sealed(next);
    await txn.put({ [ROSTER_BINDING]: result });
    return result;
}
async function loadControl(txn, env, sql) {
    const b = await txn.get(ROSTER_BINDING);
    if (!exact(b, fields) || b.version !== 2 || b.protocol !== PUSH_ROSTER_PROTOCOL || b.project_id !== PUSH_LEDGER_PROJECT || b.ledger_id !== env.PUSH_LEDGER_ID ||
        !UUID.test(b.bootstrap_id) || !HASH.test(b.provider_generation) || !['serving', 'quarantined'].includes(b.state) ||
        b.state === 'serving' && b.reason !== null || b.state === 'quarantined' && !reasons.includes(b.reason) ||
        !integer(b.created_at, 1) || !integer(b.last_at, b.created_at) || !integer(b.revision) || !HASH.test(b.binding_sha256) ||
        Object.keys(tables).some(name => !integer(b[name])) || b.outcomes > b.intents || b.intents > b.entries ||
        b.generations < 1 || b.retired_generations !== b.generations - 1)
        fail(503, 'push_roster_binding_unavailable');
    const { binding_sha256, ...value } = b;
    if (binding_sha256 !== await sha256(canonical(value)))
        fail(503, 'push_roster_integrity_failed');
    for (const [name, table] of Object.entries(tables))
        if ((await q(sql, `SELECT COUNT(*) n FROM ${table}`))[0]?.n !== b[name])
            fail(503, 'push_roster_integrity_failed');
    const latest = (await q(sql, `SELECT provider_generation,ordinal FROM ${tables.generations} ORDER BY ordinal DESC LIMIT 1`))[0];
    if (!latest || latest.provider_generation !== b.provider_generation || latest.ordinal !== b.generations)
        fail(503, 'push_roster_integrity_failed');
    return b;
}
function clock(now, binding) { const value = now(); if (!integer(value, 1) || value > Number.MAX_SAFE_INTEGER - 30000)
    fail(503, 'ledger_clock_invalid'); return Math.max(value, binding?.last_at ?? 0); }
function input(value, env, names) { if (!exact(value, ['version', 'project_id', 'ledger_id', ...names]) || value.version !== 2 || value.project_id !== PUSH_LEDGER_PROJECT || value.ledger_id !== env.PUSH_LEDGER_ID)
    fail(400, 'push_roster_input_invalid'); }
function operation(value) { const match = typeof value === 'string' && OPERATION.exec(value); if (!match || !UUID.test(match[1]) || !UUID.test(match[2]))
    fail(400, 'operation_invalid'); return value; }
function serving(b, generation) { if (b.state !== 'serving')
    fail(503, 'push_roster_quarantined'); if (generation !== b.provider_generation)
    fail(409, 'push_provider_generation_changed'); }
const retired = async (sql, plan) => (await q(sql, `SELECT notification_id FROM ${tables.retired_plans} WHERE notification_id=?`, plan.notification_id)).length > 0 ||
    (await q(sql, `SELECT subject_sha256 FROM ${tables.subjects} WHERE subject_sha256=?`, plan.subject_sha256)).length > 0 ||
    (await q(sql, `SELECT provider_generation FROM ${tables.retired_generations} WHERE provider_generation=?`, plan.provider_generation)).length > 0;
async function loadPlan(sql, id) {
    const row = (await q(sql, `SELECT * FROM ${tables.plans} WHERE notification_id=?`, id))[0];
    if (!row) {
        if ((await q(sql, `SELECT operation_key FROM ${tables.entries} WHERE notification_id=? LIMIT 1`, id)).length)
            fail(503, 'push_roster_integrity_failed');
        return null;
    }
    let plan;
    try {
        plan = validatePlan(JSON.parse(row.plan_json));
    }
    catch {
        fail(503, 'push_roster_integrity_failed');
    }
    if (plan.notification_id !== id || plan.subject_sha256 !== row.subject_sha256 || plan.provider_generation !== row.provider_generation ||
        await sha256(canonical(plan)) !== row.plan_sha256 || canonical(plan) !== row.plan_json || !integer(row.created_at, 1))
        fail(503, 'push_roster_integrity_failed');
    const entries = (await q(sql, `SELECT * FROM ${tables.entries} WHERE notification_id=? ORDER BY ordinal LIMIT 11`, id));
    if (entries.length !== plan.attempts.length)
        fail(503, 'push_roster_integrity_failed');
    for (let index = 0; index < entries.length; index++)
        if (entries[index].ordinal !== index || entries[index].operation_key !== plan.attempts[index].operation_key ||
            entries[index].entry_sha256 !== await sha256(canonical(plan.attempts[index])) || !UUID.test(entries[index].provider_request_id))
            fail(503, 'push_roster_integrity_failed');
    return { plan, plan_sha256: row.plan_sha256, entries };
}
async function receipt(sql, loaded, entry, at) {
    const intended = loaded.plan.attempts[entry.ordinal];
    const intent = (await q(sql, `SELECT * FROM ${tables.intents} WHERE operation_key=?`, entry.operation_key))[0];
    const outcome = (await q(sql, `SELECT * FROM ${tables.outcomes} WHERE operation_key=?`, entry.operation_key))[0];
    const claim = (await q(sql, `SELECT * FROM ${claims} WHERE operation_key=?`, entry.operation_key))[0];
    if (outcome && !intent || intent && (intent.provider_request_id !== entry.provider_request_id || !integer(intent.dispatched_at, 1)) ||
        outcome && (!['accepted', 'rejected'].includes(outcome.status) || ![0, 1].includes(outcome.retryable) || ![0, 1].includes(outcome.token_invalid) ||
            !integer(outcome.observed_at, intent.dispatched_at)))
        fail(503, 'push_roster_integrity_failed');
    let result;
    if (outcome) {
        try {
            result = validateOutcome({ status: outcome.status, provider_message_id: outcome.provider_message_id, provider_code: outcome.provider_code, retryable: outcome.retryable === 1, token_invalid: outcome.token_invalid === 1 });
        }
        catch {
            fail(503, 'push_roster_integrity_failed');
        }
    }
    else
        result = { status: intent ? (intent.dispatched_at <= at - 60000 ? 'ambiguous' : 'dispatching') : (await retired(sql, loaded.plan)) ? 'cancelled' : claim && claim.lease_until > at ? 'preparing' : 'unstarted' };
    return { protocol: PUSH_RECEIPT_V2, operation_key: entry.operation_key, notification_id: loaded.plan.notification_id,
        plan_sha256: loaded.plan_sha256, provider_generation: loaded.plan.provider_generation, request_sha256: intended.request_sha256,
        token_sha256: intended.token_sha256, provider_request_id: entry.provider_request_id, ...result };
}
async function roster(sql, loaded, at) {
    return { plan: loaded.plan, plan_sha256: loaded.plan_sha256, retired: (await retired(sql, loaded.plan)),
        receipts: await Promise.all(loaded.entries.map(async (entry) => (await receipt(sql, loaded, entry, at)))) };
}
async function entryFor(sql, key) {
    const match = OPERATION.exec(operation(key)), loaded = await loadPlan(sql, match[1]);
    const entry = loaded?.entries.find(entry => entry.operation_key === key);
    if (!entry)
        fail(404, 'push_plan_operation_missing');
    return { loaded, entry };
}
async function initializeSQL(sql) {
    if (sql.initializeRoster) {
        await sql.initializeRoster();
        return;
    }
    const statements = [
        `CREATE TABLE ${tables.plans}(notification_id TEXT PRIMARY KEY,subject_sha256 TEXT NOT NULL,provider_generation TEXT NOT NULL,plan_sha256 TEXT NOT NULL UNIQUE,plan_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`,
        `CREATE INDEX push_roster_subject_v2 ON ${tables.plans}(subject_sha256,notification_id)`,
        `CREATE TABLE ${tables.entries}(operation_key TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES ${tables.plans}(notification_id),ordinal INTEGER NOT NULL,entry_sha256 TEXT NOT NULL,provider_request_id TEXT NOT NULL UNIQUE,UNIQUE(notification_id,ordinal)) STRICT`,
        `CREATE TABLE ${claims}(operation_key TEXT PRIMARY KEY REFERENCES ${tables.entries}(operation_key),claim_id TEXT,lease_until INTEGER NOT NULL,provider_code TEXT,updated_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.intents}(operation_key TEXT PRIMARY KEY REFERENCES ${tables.entries}(operation_key),provider_request_id TEXT NOT NULL UNIQUE,dispatched_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.outcomes}(operation_key TEXT PRIMARY KEY REFERENCES ${tables.intents}(operation_key),status TEXT NOT NULL CHECK(status IN('accepted','rejected')),provider_message_id TEXT,provider_code TEXT,retryable INTEGER NOT NULL CHECK(retryable IN(0,1)),token_invalid INTEGER NOT NULL CHECK(token_invalid IN(0,1)),observed_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.subjects}(subject_sha256 TEXT PRIMARY KEY,created_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.retired_plans}(notification_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.generations}(provider_generation TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,created_at INTEGER NOT NULL) STRICT`,
        `CREATE TABLE ${tables.retired_generations}(provider_generation TEXT PRIMARY KEY REFERENCES ${tables.generations}(provider_generation),created_at INTEGER NOT NULL) STRICT`,
    ];
    for (const statement of statements)
        (await q(sql, statement));
    for (const table of Object.values(tables))
        for (const action of ['UPDATE', 'DELETE'])
            (await q(sql, `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_push_roster'); END`));
}
export function rosterRoute(request) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || request.headers.has('Upgrade'))
        fail(400, 'transport_invalid');
    const fixed = { '/v2/bootstrap': ['POST', 'bootstrap'], '/v2/control': ['GET', 'control'], '/v2/fence': ['POST', 'fence'],
        '/v2/generations/activate': ['POST', 'activate'], '/v2/plans': ['POST', 'plan'], '/v2/operations/reserve': ['POST', 'reserve'] };
    let route;
    if (Object.hasOwn(fixed, url.pathname)) {
        const [method, kind] = fixed[url.pathname];
        route = { kind, method };
    }
    else {
        let match = /^\/v2\/plans\/([0-9a-f-]{36})(?:\/(retire))?$/.exec(url.pathname);
        if (match && UUID.test(match[1]))
            route = { kind: match[2] ? 'retire-plan' : 'lookup-plan', id: match[1], method: match[2] ? 'POST' : 'GET' };
        match = /^\/v2\/subjects\/([0-9a-f]{64})\/(retire|proof)$/.exec(url.pathname);
        if (match)
            route = { kind: match[2] === 'retire' ? 'retire-subject' : 'subject-proof', id: match[1], method: match[2] === 'retire' ? 'POST' : 'GET' };
        match = /^\/v2\/plans\/page\/(0|[0-9a-f-]{36})$/.exec(url.pathname);
        if (match && (match[1] === '0' || UUID.test(match[1])))
            route = { kind: 'list-plans', after: match[1] === '0' ? '' : match[1], method: 'GET' };
        match = /^\/v2\/operations\/([^/]+)(?:\/(preflight-failed|start|finish))?$/.exec(url.pathname);
        if (match) {
            let key;
            try {
                key = decodeURIComponent(match[1]);
            }
            catch {
                fail(404, 'route_unavailable');
            }
            operation(key);
            if (encodeURIComponent(key) !== match[1])
                fail(404, 'route_unavailable');
            route = { kind: match[2] ?? 'lookup', key, method: match[2] ? 'POST' : 'GET' };
        }
    }
    if (!route)
        fail(404, 'route_unavailable');
    if (request.method !== route.method)
        fail(405, 'method_unavailable');
    return route;
}
async function readJSON(request) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding'))
        fail(415, 'content_type_invalid');
    const length = request.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > ROSTER_BODY_LIMIT))
        fail(413, 'ledger_request_too_large');
    const reader = request.body?.getReader();
    if (!reader)
        fail(400, 'push_roster_input_invalid');
    const chunks = [];
    let size = 0, timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new PushLedgerError(408, 'ledger_request_deadline')), 10000); });
    try {
        for (;;) {
            const item = await Promise.race([reader.read(), timeout]);
            if (item.done)
                break;
            size += item.value.byteLength;
            if (size > ROSTER_BODY_LIMIT)
                fail(413, 'ledger_request_too_large');
            chunks.push(item.value);
        }
        if (length !== null && Number(length) !== size)
            fail(400, 'ledger_length_invalid');
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch {
            fail(400, 'push_roster_input_invalid');
        }
        finally {
            bytes.fill(0);
        }
    }
    finally {
        clearTimeout(timer);
        for (const chunk of chunks)
            chunk.fill(0);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export async function executeRoster(storage, env, route, value, { now = Date.now } = {}) {
    if (route.kind === 'bootstrap') {
        input(value, env, ['bootstrap_id', 'provider_generation']);
        if (!UUID.test(value.bootstrap_id) || !HASH.test(value.provider_generation))
            fail(400, 'push_roster_input_invalid');
        return storage.transaction(async (txn) => {
            const sql = txn.sql ?? storage.sql;
            if (await txn.get(ROSTER_BINDING) !== undefined) {
                const b = await loadControl(txn, env, sql);
                if (b.bootstrap_id !== value.bootstrap_id || b.provider_generation !== value.provider_generation)
                    fail(409, 'push_roster_binding_conflict');
                return envelope(b);
            }
            const original = await loadBinding(txn, env, sql);
            // A legacy dispatch cannot acquire an invented provider generation or
            // complete device plan. Preserve it read-only for explicit reconciliation.
            if (original.state !== 'serving' || original.records !== 0 || original.dispatches !== 0 || (await txn.list({ limit: 2 })).size !== 1 ||
                (sql.rosterInitialized ? await sql.rosterInitialized() : (await q(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'push_roster_%'")).length))
                fail(503, 'push_roster_legacy_history_unbound');
            (await initializeSQL(sql));
            const at = clock(now);
            (await q(sql, `INSERT INTO ${tables.generations}(provider_generation,ordinal,created_at) VALUES(?,1,?)`, value.provider_generation, at));
            const b = await sealed({ version: 2, protocol: PUSH_ROSTER_PROTOCOL, project_id: PUSH_LEDGER_PROJECT, ledger_id: env.PUSH_LEDGER_ID,
                bootstrap_id: value.bootstrap_id, provider_generation: value.provider_generation, state: 'serving', reason: null, created_at: at, last_at: at, revision: 0,
                ...Object.fromEntries(Object.keys(tables).map(name => [name, name === 'generations' ? 1 : 0])) });
            await txn.put({ [ROSTER_BINDING]: b });
            return envelope(b);
        });
    }
    if (route.method !== 'GET') {
        const expected = { fence: ['reason'], activate: ['previous_generation', 'provider_generation'], plan: ['plan', 'plan_sha256'], reserve: ['operation_key', 'plan_sha256', 'request_sha256', 'provider_generation'],
            'retire-plan': [], 'retire-subject': [], 'preflight-failed': ['claim_id', 'code'], start: ['claim_id', 'provider_generation'], finish: ['result'] }[route.kind];
        input(value, env, expected ?? []);
    }
    return storage.transaction(async (txn) => {
        const sql = txn.sql ?? storage.sql;
        let b = await loadControl(txn, env, sql);
        const at = clock(now, b);
        if (route.kind === 'control')
            return envelope(b);
        if (route.kind === 'fence') {
            if (!reasons.includes(value.reason))
                fail(400, 'push_roster_input_invalid');
            if (b.state !== 'quarantined') {
                b = { ...b, state: 'quarantined', reason: value.reason };
                b = await storeControl(txn, b, at);
            }
            return envelope(b);
        }
        if (route.kind === 'activate') {
            if (!HASH.test(value.previous_generation) || !HASH.test(value.provider_generation) || value.previous_generation === value.provider_generation)
                fail(400, 'push_roster_input_invalid');
            if (b.provider_generation === value.provider_generation && (await q(sql, `SELECT provider_generation FROM ${tables.retired_generations} WHERE provider_generation=?`, value.previous_generation)).length)
                return envelope(b);
            if (b.state !== 'quarantined' || value.previous_generation !== b.provider_generation)
                fail(409, 'push_provider_generation_changed');
            if (b.intents !== b.outcomes)
                fail(503, 'push_generation_reconciliation_required');
            if ((await q(sql, `SELECT provider_generation FROM ${tables.generations} WHERE provider_generation=?`, value.provider_generation)).length)
                fail(409, 'push_generation_reuse_denied');
            (await q(sql, `INSERT INTO ${tables.retired_generations}(provider_generation,created_at) VALUES(?,?)`, b.provider_generation, at));
            (await q(sql, `INSERT INTO ${tables.generations}(provider_generation,ordinal,created_at) VALUES(?,?,?)`, value.provider_generation, b.generations + 1, at));
            b = await storeControl(txn, { ...b, provider_generation: value.provider_generation, state: 'serving', reason: null }, at, { generations: 1, retired_generations: 1 });
            return envelope(b);
        }
        if (route.kind === 'plan') {
            let plan;
            try {
                plan = validatePlan(value.plan);
            }
            catch {
                fail(400, 'push_roster_input_invalid');
            }
            const hash = await sha256(canonical(plan));
            if (value.plan_sha256 !== hash || plan.ledger_id !== b.ledger_id || plan.ledger_bootstrap_id !== b.bootstrap_id)
                fail(409, 'push_roster_binding_conflict');
            const previous = await loadPlan(sql, plan.notification_id);
            if (previous) {
                if (previous.plan_sha256 !== hash)
                    fail(409, 'push_roster_binding_conflict');
                return envelope(b, (await roster(sql, previous, at)));
            }
            serving(b, plan.provider_generation);
            if ((await q(sql, `SELECT notification_id FROM ${tables.retired_plans} WHERE notification_id=?`, plan.notification_id)).length)
                fail(409, 'push_plan_retired');
            if ((await q(sql, `SELECT subject_sha256 FROM ${tables.subjects} WHERE subject_sha256=?`, plan.subject_sha256)).length)
                fail(409, 'push_subject_retired');
            (await q(sql, `INSERT INTO ${tables.plans}(notification_id,subject_sha256,provider_generation,plan_sha256,plan_json,created_at) VALUES(?,?,?,?,?,?)`, plan.notification_id, plan.subject_sha256, plan.provider_generation, hash, canonical(plan), at));
            for (const [ordinal, entry] of plan.attempts.entries())
                (await q(sql, `INSERT INTO ${tables.entries}(operation_key,notification_id,ordinal,entry_sha256,provider_request_id) VALUES(?,?,?,?,?)`, entry.operation_key, plan.notification_id, ordinal, await sha256(canonical(entry)), crypto.randomUUID()));
            b = await storeControl(txn, b, at, { plans: 1, entries: plan.attempts.length });
            return envelope(b, (await roster(sql, await loadPlan(sql, plan.notification_id), at)));
        }
        if (route.kind === 'lookup-plan' || route.kind === 'retire-plan') {
            const loaded = await loadPlan(sql, route.id);
            if (route.kind === 'retire-plan' && !(await q(sql, `SELECT notification_id FROM ${tables.retired_plans} WHERE notification_id=?`, route.id)).length) {
                (await q(sql, `INSERT INTO ${tables.retired_plans}(notification_id,created_at) VALUES(?,?)`, route.id, at));
                b = await storeControl(txn, b, at, { retired_plans: 1 });
            }
            return envelope(b, loaded ? (await roster(sql, loaded, at)) : { plan: null, plan_sha256: null,
                retired: (await q(sql, `SELECT notification_id FROM ${tables.retired_plans} WHERE notification_id=?`, route.id)).length > 0, receipts: [] });
        }
        if (route.kind === 'retire-subject' || route.kind === 'subject-proof') {
            if (route.kind === 'retire-subject' && !(await q(sql, `SELECT subject_sha256 FROM ${tables.subjects} WHERE subject_sha256=?`, route.id)).length) {
                (await q(sql, `INSERT INTO ${tables.subjects}(subject_sha256,created_at) VALUES(?,?)`, route.id, at));
                b = await storeControl(txn, b, at, { subjects: 1 });
            }
            const isRetired = (await q(sql, `SELECT subject_sha256 FROM ${tables.subjects} WHERE subject_sha256=?`, route.id)).length === 1;
            const counts = (await q(sql, `SELECT count(DISTINCT p.notification_id) plans,count(DISTINCT i.operation_key) started,count(DISTINCT o.operation_key) settled
        FROM ${tables.plans} p LEFT JOIN ${tables.entries} e ON e.notification_id=p.notification_id
        LEFT JOIN ${tables.intents} i ON i.operation_key=e.operation_key LEFT JOIN ${tables.outcomes} o ON o.operation_key=i.operation_key
        WHERE p.subject_sha256=?`, route.id))[0];
            return envelope(b, { subject_sha256: route.id, retired: isRetired, ...counts, unresolved: counts.started - counts.settled,
                dispatch_quiescent: isRetired && counts.started === counts.settled, provider_erasure_verified: false });
        }
        if (route.kind === 'list-plans') {
            const rows = (await q(sql, `SELECT notification_id,subject_sha256,provider_generation,plan_sha256 FROM ${tables.plans} WHERE notification_id>? ORDER BY notification_id LIMIT 26`, route.after));
            const more = rows.length > 25, items = rows.slice(0, 25);
            return envelope(b, { items, next_cursor: more ? items.at(-1).notification_id : null });
        }
        const key = route.kind === 'reserve' ? operation(value.operation_key) : operation(route.key), { loaded, entry } = await entryFor(sql, key);
        const intended = loaded.plan.attempts[entry.ordinal];
        if (route.kind === 'lookup')
            return envelope(b, { receipt: (await receipt(sql, loaded, entry, at)) });
        if (route.kind === 'reserve') {
            if (value.plan_sha256 !== loaded.plan_sha256 || value.request_sha256 !== intended.request_sha256 || value.provider_generation !== loaded.plan.provider_generation)
                fail(409, 'operation_payload_conflict');
            const prior = (await receipt(sql, loaded, entry, at));
            if (!['unstarted', 'preparing'].includes(prior.status))
                return envelope(b, { receipt: prior, claim: null });
            serving(b, value.provider_generation);
            if ((await retired(sql, loaded.plan)))
                fail(409, 'push_plan_retired');
            const old = (await q(sql, `SELECT * FROM ${claims} WHERE operation_key=?`, key))[0];
            if (old && old.lease_until > at)
                return envelope(b, { receipt: prior, claim: null });
            const claim = crypto.randomUUID();
            (await q(sql, `INSERT INTO ${claims}(operation_key,claim_id,lease_until,provider_code,updated_at) VALUES(?,?,?,NULL,?)
        ON CONFLICT(operation_key) DO UPDATE SET claim_id=excluded.claim_id,lease_until=excluded.lease_until,provider_code=NULL,updated_at=excluded.updated_at`, key, claim, at + 30000, at));
            b = await storeControl(txn, b, at);
            return envelope(b, { receipt: (await receipt(sql, loaded, entry, at)), claim });
        }
        if (route.kind === 'preflight-failed') {
            if (!UUID.test(value.claim_id) || typeof value.code !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(value.code))
                fail(400, 'push_roster_input_invalid');
            (await q(sql, `UPDATE ${claims} SET claim_id=NULL,lease_until=0,provider_code=?,updated_at=? WHERE operation_key=? AND claim_id=?`, value.code, at, key, value.claim_id));
            b = await storeControl(txn, b, at);
            return envelope(b, { receipt: (await receipt(sql, loaded, entry, at)) });
        }
        if (route.kind === 'start') {
            if (!UUID.test(value.claim_id))
                fail(400, 'push_roster_input_invalid');
            serving(b, value.provider_generation);
            if (value.provider_generation !== loaded.plan.provider_generation || (await retired(sql, loaded.plan)))
                fail(409, 'push_plan_retired');
            const claim = (await q(sql, `SELECT * FROM ${claims} WHERE operation_key=?`, key))[0];
            if (!claim || claim.claim_id !== value.claim_id || claim.lease_until <= at || (await q(sql, `SELECT operation_key FROM ${tables.intents} WHERE operation_key=?`, key)).length)
                return envelope(b, { receipt: null });
            (await q(sql, `INSERT INTO ${tables.intents}(operation_key,provider_request_id,dispatched_at) VALUES(?,?,?)`, key, entry.provider_request_id, at));
            (await q(sql, `UPDATE ${claims} SET claim_id=NULL,lease_until=0,updated_at=? WHERE operation_key=?`, at, key));
            b = await storeControl(txn, b, at, { intents: 1 });
            return envelope(b, { receipt: (await receipt(sql, loaded, entry, at)) });
        }
        if (route.kind !== 'finish')
            fail(404, 'route_unavailable');
        const outcome = validateOutcome(value.result);
        if (!(await q(sql, `SELECT operation_key FROM ${tables.intents} WHERE operation_key=?`, key)).length)
            fail(409, 'push_dispatch_not_started');
        const existing = (await q(sql, `SELECT * FROM ${tables.outcomes} WHERE operation_key=?`, key))[0];
        if (existing) {
            const actual = { status: existing.status, provider_message_id: existing.provider_message_id, provider_code: existing.provider_code, retryable: existing.retryable === 1, token_invalid: existing.token_invalid === 1 };
            if (canonical(actual) !== canonical(outcome))
                fail(409, 'push_terminal_outcome_conflict');
        }
        else if (outcome.status !== 'ambiguous') {
            (await q(sql, `INSERT INTO ${tables.outcomes}(operation_key,status,provider_message_id,provider_code,retryable,token_invalid,observed_at) VALUES(?,?,?,?,?,?,?)`, key, outcome.status, outcome.provider_message_id, outcome.provider_code, outcome.retryable ? 1 : 0, outcome.token_invalid ? 1 : 0, at));
            b = await storeControl(txn, b, at, { outcomes: 1 });
        }
        const result = (await receipt(sql, loaded, entry, at));
        return envelope(b, { receipt: outcome.status === 'ambiguous' ? { ...result, status: 'ambiguous' } : result });
    });
}
export async function handleRosterRequest(request, env, storage, options) {
    try {
        const route = rosterRoute(request);
        await authenticateLedger(request, env, ['bootstrap', 'activate'].includes(route.kind));
        const value = route.method === 'GET' ? undefined : await readJSON(request);
        const result = await executeRoster(storage, env, route, value, options);
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > ROSTER_REPLY_LIMIT)
            fail(503, 'push_roster_reply_too_large');
        return ledgerResponse(result);
    }
    catch (error) {
        return ledgerError(error);
    }
}
