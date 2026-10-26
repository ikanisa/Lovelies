import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {ApiError,stable} from '../src/types.ts';
import {INFERENCE_ENGINE_SPACE} from '../src/inference-contract.ts';
import {encodeGeneration,selectedGeneration,assertGeneration} from '../src/inference-generation.ts';
import {currentSchemaVersion,schemaStatements} from '../src/schema.ts';

const identity=(extra={})=>({engine_space:INFERENCE_ENGINE_SPACE,
  engine_artifact_sha256:'a'.repeat(64),processing_fingerprint:'b'.repeat(64),...extra});
const canonical=()=>encodeGeneration(identity());
const env=()=>({INFERENCE_ENGINE_IDENTITY:canonical()});
const error=(status,code)=>value=>value instanceof ApiError&&value.status===status&&value.code===code&&value.message===code;
const unavailable=error(503,'inference_generation_unavailable');
const changed=error(409,'inference_generation_changed');

test('generation encoding is canonical, exact and independent of object key insertion order',()=>{
  const input=identity(),before=JSON.stringify(input),encoded=encodeGeneration(input);
  assert.equal(encoded,stable(input));assert.equal(JSON.stringify(input),before);
  assert.equal(encoded,encodeGeneration({processing_fingerprint:input.processing_fingerprint,
    engine_artifact_sha256:input.engine_artifact_sha256,engine_space:input.engine_space}));
  assert.equal(encoded,encodeGeneration(Object.assign(Object.create(null),input)));
  assert.deepEqual(Object.keys(JSON.parse(encoded)),['engine_artifact_sha256','engine_space','processing_fingerprint']);
});

test('generation encoder rejects missing, extra, inherited, executable and wrong-space identity fields',()=>{
  const absent=Object.fromEntries(Object.entries(identity()).filter(([key])=>key!=='processing_fingerprint'));
  const hidden=identity();Object.defineProperty(hidden,'processing_fingerprint',{value:'b'.repeat(64),enumerable:false});
  const symbolic={...identity(),[Symbol('other')]:1};
  let getterCalls=0;const getter=identity();Object.defineProperty(getter,'processing_fingerprint',{
    enumerable:true,get(){getterCalls++;throw new Error('identity getter must not run');}});
  const invalid=[undefined,null,false,4,[],canonical(),new String(canonical()),{},absent,
    {...identity(),request_id:'extra'},Object.create(identity()),hidden,symbolic,getter,
    identity({engine_space:'other-engine-space'}),identity({engine_space:INFERENCE_ENGINE_SPACE+' '}),
    identity({engine_artifact_sha256:'A'.repeat(64)}),identity({engine_artifact_sha256:'a'.repeat(63)}),
    identity({engine_artifact_sha256:'z'.repeat(64)}),identity({processing_fingerprint:null}),
    identity({processing_fingerprint:123}),identity({processing_fingerprint:'b'.repeat(65)})];
  for(const value of invalid)assert.throws(()=>encodeGeneration(value),unavailable);
  assert.equal(getterCalls,0);
});

test('selected configuration rejects duplicates, alternate JSON encodings and malformed or unavailable identities',()=>{
  assert.equal(selectedGeneration(env()),canonical());
  const value=canonical(),duplicate='{"engine_space":'+JSON.stringify(INFERENCE_ENGINE_SPACE)+','+value.slice(1);
  const reordered=JSON.stringify(identity()),escaped=value.replace('engine_space','\\u0065ngine_space');
  assert.notEqual(reordered,value);assert.notEqual(escaped,value);
  for(const selected of [undefined,null,{},false,'',value+' ', '\n'+value,reordered,
    JSON.stringify(identity(),null,2),duplicate,escaped,'{invalid',' '.repeat(513),
    stable(identity({engine_space:'old-space'})),stable({...identity(),unexpected:'field'})])
    assert.throws(()=>selectedGeneration({INFERENCE_ENGINE_IDENTITY:selected}),unavailable);
  assert.throws(()=>selectedGeneration({}),unavailable);
});

test('stored generation must match the selected artifact and preprocessing exactly, including legacy NULL',()=>{
  assert.equal(assertGeneration(canonical(),env()),canonical());
  for(const stored of [undefined,null,identity(),new String(canonical()),'',canonical()+' ',JSON.stringify(identity()),
    encodeGeneration(identity({engine_artifact_sha256:'c'.repeat(64)})),
    encodeGeneration(identity({processing_fingerprint:'d'.repeat(64)})),
    stable(identity({engine_space:'legacy-space'}))])assert.throws(()=>assertGeneration(stored,env()),changed);
  const selected=encodeGeneration(identity({engine_artifact_sha256:'c'.repeat(64)}));
  assert.throws(()=>assertGeneration(canonical(),{INFERENCE_ENGINE_IDENTITY:selected}),changed);
  assert.equal(assertGeneration(selected,{INFERENCE_ENGINE_IDENTITY:selected}),selected);
  for(const stored of [null,canonical()])assert.throws(()=>assertGeneration(stored,{}),unavailable,
    'missing serving configuration remains unavailable even for a stale operation');
});

const folder=new URL('../../../supabase/migrations/',import.meta.url);
const generation=fs.readFileSync(new URL('20261024180000_inference_generation.sql',folder),'utf8');
async function database(version=9){
  const engine=await PGlite.create();
  try{
    await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    const names=fs.readdirSync(folder).filter(name=>/_lovelies_private_core\.sql$|_refresh_delivery\.sql$/.test(name)
      ||version===9&&/_audience_retention\.sql$/.test(name)).sort();
    for(const name of names)await engine.exec(fs.readFileSync(new URL(name,folder),'utf8'));
    return engine;
  }catch(failure){await engine.close();throw failure;}
}
const protectedTables=async engine=>(await engine.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='lovelies_private' AND c.relkind='r' ORDER BY c.relname`)).rows;
const tableRows=async engine=>{
  await engine.exec('SET ROLE lovelies_api');
  try{return {challenges:(await engine.query('SELECT * FROM lovelies_private.auth_challenges ORDER BY id')).rows,
    attempts:(await engine.query('SELECT * FROM lovelies_private.processing_attempts ORDER BY id')).rows};}
  finally{await engine.exec('RESET ROLE');}
};

test('v10 upgrades and reapplies without relabelling legacy rows or changing forced RLS/grants',async()=>{
  const engine=await database();
  try{
    await engine.exec(`SET ROLE lovelies_api;
      INSERT INTO lovelies_private.accounts(id) VALUES('legacy-unknown-account');
      INSERT INTO lovelies_private.auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,created_at)
        VALUES('legacy-challenge','legacy-unknown-account','registration','legacy-nonce','legacy-policy',2000,1000);
      INSERT INTO lovelies_private.assets(id,owner_id,source,status,object_key,content_type,byte_size,version)
        VALUES('legacy-source','legacy-unknown-account','personal','processing','preserved/unknown/photo','image/jpeg',123,'source-version');
      INSERT INTO lovelies_private.processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at)
        VALUES('legacy-attempt','legacy-source','source-version','legacy-checksum','legacy-model','queued',1000,2000);
      RESET ROLE;`);
    const before=await tableRows(engine),rls=await protectedTables(engine);
    assert.equal(rls.length,67);assert(rls.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
    const originalRole=(await engine.query('SELECT current_user role')).rows[0].role;
    await engine.exec(generation);
    assert.equal((await engine.query('SELECT current_user role')).rows[0].role,originalRole);
    const after=await tableRows(engine);
    for(const rows of Object.values(after))for(const row of rows){assert.equal(row.engine_identity,null);delete row.engine_identity;}
    assert.deepEqual(after,before);assert.deepEqual(await protectedTables(engine),rls);
    const columns=(await engine.query(`SELECT table_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='engine_identity' ORDER BY table_name`)).rows;
    assert.deepEqual(columns,['auth_challenges','processing_attempts'].map(table_name=>({table_name,data_type:'text',is_nullable:'YES',column_default:null})));
    for(const role of ['anon','authenticated'])for(const table of ['auth_challenges','processing_attempts']){
      assert.equal((await engine.query('SELECT has_column_privilege($1,$2,$3,$4) permitted',
        [role,'lovelies_private.'+table,'engine_identity','SELECT'])).rows[0].permitted,false);
    }
    for(const table of ['auth_challenges','processing_attempts'])assert.equal((await engine.query(
      'SELECT has_column_privilege($1,$2,$3,$4) permitted',['lovelies_api','lovelies_private.'+table,'engine_identity','UPDATE'])).rows[0].permitted,true);
    await engine.exec(generation);
    await engine.exec('SET ROLE lovelies_api');
    assert.equal(Number((await engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),10);
    assert.equal(Number((await engine.query('SELECT count(*) n FROM lovelies_private.schema_versions WHERE version=10')).rows[0].n),1);
    await engine.exec('RESET ROLE');
    assert.equal(currentSchemaVersion,12,'current engine includes the additive restore checkpoint after historical v10');
    for(const table of ['auth_challenges','processing_attempts'])assert.match(
      schemaStatements.find(statement=>statement.startsWith('CREATE TABLE IF NOT EXISTS '+table+'(')),/engine_identity TEXT/);
    await engine.exec("ALTER TABLE lovelies_private.auth_challenges ALTER COLUMN engine_identity SET DEFAULT 'forbidden-backfill'");
    await assert.rejects(()=>engine.exec(generation),/inference_generation_columns_invalid/);
  }finally{await engine.close();}
});

test('v10 refuses an unprepared v8 baseline before adding either identity column',async()=>{
  const engine=await database(8);
  try{
    await assert.rejects(()=>engine.exec(generation),/inference_generation_requires_schema_v9/);
    assert.equal((await engine.query(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='lovelies_private' AND column_name='engine_identity'`)).rows[0].n,0);
  }finally{await engine.close();}
});
