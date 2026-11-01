/** Transactional custody on a separately operated local Supabase PostgreSQL.
 * The protocol callback is executed once, under a namespace advisory lock.
 * No retry can reinterpret an uncertain commit as permission for another effect.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const namespaces = Object.freeze({ restore_journal: 1, push_receipts: 2 });
const numericColumns = new Set(['records','n','plans','started','settled','created_at','updated_at','dispatched_at','observed_at','lease_until','ordinal','retryable','token_invalid']);
const pushTables = ['push_dispatch_admissions_v1','push_dispatch_intents_v1'];
const rosterTables = ['push_roster_plans_v2','push_roster_entries_v2','push_roster_claims_v2','push_roster_intents_v2','push_roster_outcomes_v2','push_roster_subject_retirements_v2','push_roster_plan_retirements_v2','push_roster_generations_v2','push_roster_generation_retirements_v2'];
const invalid = () => new Error('custody_configuration_invalid');
const corrupt = () => new Error('custody_storage_invalid');
function rows(result) {
  return Array.from(result.rows ?? result, row => Object.fromEntries(Object.entries(row).map(([key,value]) => {
    if (numericColumns.has(key) && (typeof value === 'bigint' || typeof value === 'string' && /^-?[0-9]+$/.test(value))) {
      const number = Number(value); if (!Number.isSafeInteger(number)) throw corrupt(); return [key,number];
    }
    return [key,value];
  })));
}
function key(value, empty = false) {
  if (typeof value !== 'string' || value.length > 768 || (!empty && !value.length) || /[^\x20-\x7e]/.test(value)) throw corrupt();
  return value;
}
function json(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2_097_152) throw corrupt();
  return encoded;
}
export async function custodyConnectionOptions(env = process.env) {
  let url; try { url = new URL(env.CUSTODY_DATABASE_URL); } catch { throw invalid(); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      url.search || url.hash || !/^\/[A-Za-z0-9_]+$/.test(url.pathname) || ['postgres','supabase_admin'].includes(decodeURIComponent(url.username))) throw invalid();
  let ssl;
  if (env.CUSTODY_DATABASE_TLS_MODE === 'verify-full') {
    ssl = { rejectUnauthorized: true };
    if (env.CUSTODY_DATABASE_CA_FILE) ssl.ca = await readFile(env.CUSTODY_DATABASE_CA_FILE, 'utf8');
  } else if (env.CUSTODY_DATABASE_TLS_MODE === 'disable-internal') {
    const trusted = (env.CUSTODY_DATABASE_TRUSTED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (env.CUSTODY_DATABASE_CA_FILE || !trusted.includes(url.hostname) || trusted.some(host => !/^[a-z0-9][a-z0-9.-]*$/i.test(host))) throw invalid();
    ssl = false;
  } else throw invalid();
  return { url: url.href, options: { max: 4, ssl, connect_timeout: 10, idle_timeout: 20, prepare: false, onnotice: () => {} } };
}
export async function connectCustodyDatabase(env = process.env) {
  const configuration = await custodyConnectionOptions(env);
  const sql = postgres(configuration.url, configuration.options);
  const wrap = connection => ({
    query: async (statement, parameters = []) => rows(await connection.unsafe(statement, parameters)),
    transaction: callback => connection.begin(inner => callback(wrap(inner))),
  });
  return { ...wrap(sql), close: () => sql.end({timeout: 5}) };
}

export function createPostgresStorage(database, namespace, { acquireLock = true } = {}) {
  if (!Object.hasOwn(namespaces, namespace) || typeof database?.transaction !== 'function' || typeof database?.query !== 'function') throw invalid();
  const table = `"${namespace}".kv`;
  const activeVersion = async (db, name) => (await db.query(`SELECT protocol FROM "${namespace}".protocol_activation WHERE protocol=$1`,[name])).length > 0;
  const initializeVersion = async (db, name, tables) => {
    if (await activeVersion(db,name)) throw new Error('custody_protocol_already_initialized');
    for (const name of tables) if (Number((await db.query(`SELECT COUNT(*) AS n FROM "${namespace}"."${name}"`))[0]?.n) !== 0) throw new Error('custody_initialization_refused');
    await db.query(`INSERT INTO "${namespace}".protocol_activation(protocol) VALUES($1)`,[name]);
  };
  return {
    namespace,
    async health() {
      const expectedRole=namespace==='restore_journal'?'lovelies_journal':'lovelies_push';
      const roles=await database.query('SELECT current_user AS actor,rolsuper,rolinherit,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,EXISTS(SELECT FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=current_user');
      if(roles.length!==1||roles[0].actor!==expectedRole||Object.entries(roles[0]).some(([name,value])=>name!=='actor'&&value!==false))throw invalid();
      const result = await database.query(`SELECT version FROM "${namespace}".schema_version WHERE singleton=TRUE`);
      if (result.length !== 1 || Number(result[0].version) !== 1) throw corrupt();
      return true;
    },
    async transaction(callback) {
      return database.transaction(async connection => {
        // READ COMMITTED obtains the snapshot after the serialized writer has
        // committed. A snapshot taken before waiting on the lock would be stale.
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.query("SET LOCAL statement_timeout = '15s'");
        await connection.query("SET LOCAL lock_timeout = '10s'");
        if (acquireLock) await connection.query('SELECT pg_advisory_xact_lock($1,$2)',[1819242345,namespaces[namespace]]);
        await connection.query(`SET LOCAL search_path TO "${namespace}", pg_catalog`);
        let active = true;
        const check = () => { if (!active) throw new Error('custody_transaction_closed'); };
        const transaction = {
          async get(name) {
            check(); key(name);
            const values = await connection.query(`SELECT value FROM ${table} WHERE key=$1`,[name]);
            check(); return values.length ? structuredClone(values[0].value) : undefined;
          },
          async put(values) {
            check();
            if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 1024) throw corrupt();
            for (const [name,value] of Object.entries(values)) {
              key(name);
              // This parameter is already validated JSON text. An inferred
              // jsonb parameter would make postgres.js JSON.stringify it again.
              await connection.query(`INSERT INTO ${table}(key,value) VALUES($1,$2::text::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[name,json(value)]);
              check();
            }
          },
          async list({prefix='',startAfter,reverse=false,limit=1000} = {}) {
            check(); key(prefix,true);
            if (startAfter !== undefined) key(startAfter);
            if (typeof reverse !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw corrupt();
            const values = [prefix,prefix+'\x7f'];
            let query = `SELECT key,value FROM ${table} WHERE key >= $1 COLLATE "C" AND key < $2 COLLATE "C"`;
            if (startAfter !== undefined) {values.push(startAfter);query += ` AND key > $${values.length} COLLATE "C"`;}
            values.push(limit);query += ` ORDER BY key COLLATE "C" ${reverse?'DESC':'ASC'} LIMIT $${values.length}`;
            const result = await connection.query(query,values);check();
            return new Map(result.map(row => [row.key,structuredClone(row.value)]));
          },
        };
        if (namespace === 'push_receipts') transaction.sql = {
          dialect: 'postgres',
          async exec(statement,...parameters) {
            check();
            // Statements are fixed in the state machine. Caller input is bound
            // separately; runtime roles have no DDL or schema-owner authority.
            if (!/^\s*(SELECT|INSERT|UPDATE)\b/i.test(statement) || /;/.test(statement)) throw corrupt();
            let index=0;const prepared=statement.replace(/\?/g,()=>'$'+(++index));
            if(index!==parameters.length) throw corrupt();
            const result=rows(await connection.query(prepared,parameters));check();
            return {toArray:()=>result};
          },
          initializeLedger: () => initializeVersion(connection,'push_dispatch_v1',[...pushTables,...rosterTables]),
          initializeRoster: () => initializeVersion(connection,'push_roster_v2',rosterTables),
          rosterInitialized: () => activeVersion(connection,'push_roster_v2'),
        };
        try { return await callback(transaction); } finally { active=false; }
      });
    },
  };
}
