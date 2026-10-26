import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { isolatedPostgres } from './postgres-harness.mjs';

const folder = new URL('../../../supabase/migrations/', import.meta.url);
const baseline = ['20261023162016_lovelies_private_core.sql', '20261023210000_refresh_delivery.sql',
  '20261024170000_audience_retention.sql', '20261024180000_inference_generation.sql',
  '20261024190000_retention_scan_cursors.sql', '20261026132612_restore_control.sql'];
const migration = fs.readFileSync(new URL('20261026224211_lovelies_media_authority.sql', folder), 'utf8');
const rows = async (engine, sql, values = []) => (await engine.query(sql, values)).rows;
const asBackend = async (engine, callback) => {
  await engine.exec('SET ROLE lovelies_api');
  try { return await callback(); } finally { await engine.exec('RESET ROLE'); }
};
async function baselineDatabase(t) {
  const local = process.env.TEST_DATABASE_URL ? await isolatedPostgres(process.env.TEST_DATABASE_URL) : null;
  const engine = local?.engine ?? await PGlite.create();
  t.after(() => engine.close());
  if (!local) await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  for (const name of baseline) await engine.exec(fs.readFileSync(new URL(name, folder), 'utf8'));
  return engine;
}
async function snapshot(engine) {
  const names = (await rows(engine, "SELECT tablename FROM pg_tables WHERE schemaname='lovelies_private' ORDER BY tablename")).map(row => row.tablename);
  const result = {};
  await asBackend(engine, async () => {
    for (const name of names) {
      assert.match(name, /^[a-z_]+$/);
      const projected = ['media_tickets', 'download_tickets'].includes(name) ? "to_jsonb(t)-'authority_json'" : 'to_jsonb(t)';
      const records = await rows(engine, `SELECT ${projected} AS row FROM lovelies_private."${name}" t ORDER BY ${projected}::text`);
      result[name] = createHash('sha256').update(JSON.stringify(records)).digest('hex');
    }
  });
  return result;
}
const protections = engine => rows(engine, `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND c.relkind='r' ORDER BY c.relname`);
const policies = engine => rows(engine, "SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='lovelies_private' ORDER BY tablename,policyname");
const acl = engine => rows(engine, "SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='lovelies_private' ORDER BY table_name,grantee,privilege_type");
async function seed(engine) {
  const id = () => randomUUID(), account=id(), session=id(), asset=id(), rendition=id(), subscription=id(), preview=id(), download=id();
  await asBackend(engine, async () => {
    await engine.query("INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES($1,'Synthetic preserved account',1)", [account]);
    await engine.query("INSERT INTO lovelies_private.sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES($1,$2,$3,1000,2000,1,'anonymous',1)", [session,account,id()]);
    await engine.query("INSERT INTO lovelies_private.assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES($1,$2,'personal','ready',$3,'image/jpeg',1,'v1',1)", [asset,account,'source/'+id()]);
    await engine.query("INSERT INTO lovelies_private.renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status) VALUES($1,$2,$3,'image/jpeg',1,'checksum','checksum','r1','ready')", [rendition,asset,'preview/'+id()]);
    await engine.query("INSERT INTO lovelies_private.store_subscriptions(id,account_id,provider,app_identity,original_id,product_id,billing_environment,active,starts_at,expires_at,observed_at,transaction_id) VALUES($1,$2,'apple','synthetic',$3,'synthetic','sandbox',1,1,1000,1,$4)", [subscription,account,id(),id()]);
    await engine.query("INSERT INTO lovelies_private.media_tickets(id,account_id,session_id,asset_id,rendition_id,asset_version,rendition_version,expires_at) VALUES($1,$2,$3,$4,$5,'v1','r1',1000)", [preview,account,session,asset,rendition]);
    await engine.query("INSERT INTO lovelies_private.download_tickets(id,account_id,session_id,asset_id,asset_version,source_checksum,subscription_id,subscription_version,expires_at,created_at) VALUES($1,$2,$3,$4,'v1','checksum',$5,1,1000,1)", [download,account,session,asset,subscription]);
    await engine.query("INSERT INTO lovelies_private.moderation_holds(id,subject_id,active,created_at,reason) VALUES($1,$2,1,1,'synthetic preservation hold')", [id(),account]);
    await engine.query("INSERT INTO lovelies_private.restore_control(singleton,project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash) VALUES(1,'ltqfplqevxztlswlzexn',$1,$2,0,$3,0,$4)", [id(),id(),'a'.repeat(64),'0'.repeat(64)]);
  });
  return { preview, download };
}

test('v13 preserves populated v12 private data, ticket projections, restore marker, RLS, policies and ACLs', async t => {
  const engine = await baselineDatabase(t), ids = await seed(engine);
  const before = await snapshot(engine), beforeProtection = await protections(engine), beforePolicies = await policies(engine), beforeAcl = await acl(engine);
  const history = await asBackend(engine, () => rows(engine, 'SELECT version,applied_at FROM lovelies_private.schema_versions ORDER BY version'));
  assert.deepEqual(history.map(row => Number(row.version)), [7,8,9,10,11,12]);
  assert.equal(Object.keys(before).length, 69);
  await engine.exec(migration);
  const after = await snapshot(engine);
  for (const name of Object.keys(before)) if (name !== 'schema_versions') assert.equal(after[name], before[name], name);
  assert.deepEqual(await protections(engine), beforeProtection); assert.deepEqual(await policies(engine), beforePolicies); assert.deepEqual(await acl(engine), beforeAcl);
  const columns = await rows(engine, "SELECT table_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='authority_json' ORDER BY table_name");
  assert.deepEqual(columns.map(row => ({ ...row })), ['download_tickets','media_tickets'].map(table_name => ({ table_name, data_type:'text', is_nullable:'YES', column_default:null })));
  await asBackend(engine, async () => {
    for (const [table,id] of [['media_tickets',ids.preview],['download_tickets',ids.download]]) {
      assert.equal((await rows(engine, `SELECT authority_json FROM lovelies_private.${table} WHERE id=$1`, [id]))[0].authority_json, null);
      await engine.query(`UPDATE lovelies_private.${table} SET authority_json=$1 WHERE id=$2`, ['{"authority":"synthetic"}',id]);
      for (const value of ['null','[]','1','"text"','{']) await assert.rejects(() => engine.query(`UPDATE lovelies_private.${table} SET authority_json=$1 WHERE id=$2`, [value]));
      assert.equal((await rows(engine, `SELECT authority_json FROM lovelies_private.${table} WHERE id=$1`, [id]))[0].authority_json, '{"authority":"synthetic"}');
      await engine.query(`UPDATE lovelies_private.${table} SET authority_json=NULL WHERE id=$1`, [id]);
    }
    assert.equal(Number((await rows(engine, 'SELECT max(version) n FROM lovelies_private.schema_versions'))[0].n),13);
    const afterHistory = await rows(engine, 'SELECT version,applied_at FROM lovelies_private.schema_versions ORDER BY version');
    assert.deepEqual([...afterHistory].slice(0, history.length).map(row => ({ ...row })), [...history].map(row => ({ ...row })));
    assert.deepEqual(afterHistory.map(row => Number(row.version)), [7,8,9,10,11,12,13]);
  });
  for (const client of ['anon','authenticated']) {
    for (const table of ['media_tickets','download_tickets']) {
      const permitted = await rows(engine, 'SELECT has_column_privilege($1,$2,$3,$4) allowed', [client, 'lovelies_private.'+table, 'authority_json', 'SELECT,UPDATE']);
      assert.equal(permitted[0].allowed, false);
    }
    await engine.exec('SET ROLE '+client);
    try {
      for (const table of ['media_tickets','download_tickets'])
        await assert.rejects(() => engine.query(`SELECT authority_json FROM lovelies_private.${table}`), error => error?.code === '42501');
    } finally { await engine.exec('RESET ROLE'); }
  }
  await assert.rejects(() => engine.exec(migration), /media_authority_requires_schema_v12/);
  assert.deepEqual(await snapshot(engine), after, 'duplicate migration has no effect');
});

test('v13 rejects wrong baseline before adding either column or advancing history', async t => {
  const engine = await baselineDatabase(t);
  await asBackend(engine, () => engine.exec('DELETE FROM lovelies_private.schema_versions WHERE version=12'));
  await assert.rejects(() => engine.exec(migration), /media_authority_requires_schema_v12/);
  assert.equal((await rows(engine, "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='authority_json'"))[0].n,0);
  assert.equal(Number((await asBackend(engine, () => rows(engine, 'SELECT max(version) n FROM lovelies_private.schema_versions')))[0].n),11);
});

test('v13 rolls back its first column when the second already exists', async t => {
  const engine = await baselineDatabase(t);
  await engine.exec('ALTER TABLE lovelies_private.download_tickets ADD COLUMN authority_json TEXT');
  await assert.rejects(() => engine.exec(migration));
  const found = await rows(engine, "SELECT table_name FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='authority_json' ORDER BY table_name");
  assert.deepEqual(found.map(row => row.table_name), ['download_tickets']);
  assert.equal(Number((await asBackend(engine, () => rows(engine, 'SELECT max(version) n FROM lovelies_private.schema_versions')))[0].n),12);
});
