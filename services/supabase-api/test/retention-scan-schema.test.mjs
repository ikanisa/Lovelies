import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {currentSchemaVersion,schemaStatements} from '../src/schema.ts';

const folder=new URL('../../../supabase/migrations/',import.meta.url);
const migration=fs.readFileSync(new URL('20261024190000_retention_scan_cursors.sql',folder),'utf8');
async function baseline(version=10){
  const engine=await PGlite.create();
  try{
    await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    const names=['20261023162016_lovelies_private_core.sql','20261023210000_refresh_delivery.sql',
      '20261024170000_audience_retention.sql',...(version===10?['20261024180000_inference_generation.sql']:[])];
    for(const name of names)await engine.exec(fs.readFileSync(new URL(name,folder),'utf8'));
    return engine;
  }catch(error){await engine.close();throw error;}
}
const protection=async engine=>(await engine.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='lovelies_private' AND c.relkind='r' ORDER BY c.relname`)).rows;

test('v11 adds one empty private cursor table without changing existing rows or protection',async()=>{
  const engine=await baseline();
  try{
    await engine.exec(`SET ROLE lovelies_api;
      INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES('preserved-test-account','Preserved test record',1000);
      INSERT INTO lovelies_private.assets(id,owner_id,source,status,object_key,content_type,byte_size,version)
        VALUES('preserved-test-photo','preserved-test-account','personal','ready','preserved/test/photo','image/jpeg',123,'preserved-version');
      RESET ROLE;`);
    const existingProtection=await protection(engine),originalRole=(await engine.query('SELECT current_user role')).rows[0].role;
    assert.equal(existingProtection.length,67);
    await engine.exec('SET ROLE lovelies_api');
    const account=(await engine.query("SELECT * FROM lovelies_private.accounts WHERE id='preserved-test-account'")).rows[0];
    const asset=(await engine.query("SELECT * FROM lovelies_private.assets WHERE id='preserved-test-photo'")).rows[0];
    await engine.exec('RESET ROLE');
    await engine.exec(migration);
    assert.equal((await engine.query('SELECT current_user role')).rows[0].role,originalRole);
    const allProtection=await protection(engine),cursor=allProtection.find(row=>row.relname==='retention_scan_cursors');
    assert.equal(allProtection.length,68);
    assert.deepEqual(allProtection.filter(row=>row.relname!=='retention_scan_cursors'),existingProtection);
    assert.deepEqual(cursor,{relname:'retention_scan_cursors',relrowsecurity:true,relforcerowsecurity:true});
    const columns=(await engine.query(`SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='lovelies_private' AND table_name='retention_scan_cursors' ORDER BY ordinal_position`)).rows;
    assert.deepEqual(columns,[{column_name:'scan',data_type:'text',is_nullable:'NO',column_default:null},
      {column_name:'entity_id',data_type:'text',is_nullable:'NO',column_default:"''::text"},
      {column_name:'last_at',data_type:'bigint',is_nullable:'YES',column_default:null},
      {column_name:'last_id',data_type:'text',is_nullable:'YES',column_default:null}]);
    for(const client of ['anon','authenticated'])assert.equal((await engine.query(
      "SELECT has_table_privilege($1,'lovelies_private.retention_scan_cursors','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') permitted",[client])).rows[0].permitted,false);
    await engine.exec('SET ROLE lovelies_api');
    assert.equal(Number((await engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),11);
    assert.equal(Number((await engine.query('SELECT count(*) n FROM lovelies_private.schema_versions WHERE version=11')).rows[0].n),1);
    assert.equal(Number((await engine.query('SELECT count(*) n FROM lovelies_private.retention_scan_cursors')).rows[0].n),0);
    assert.deepEqual((await engine.query("SELECT * FROM lovelies_private.accounts WHERE id='preserved-test-account'")).rows[0],account);
    assert.deepEqual((await engine.query("SELECT * FROM lovelies_private.assets WHERE id='preserved-test-photo'")).rows[0],asset);
    assert.equal(Number((await engine.query('SELECT count(*) n FROM lovelies_private.account_audience')).rows[0].n),0,'no age declaration backfill');
    assert.equal(currentSchemaVersion,13,'current engine retains historical cursors and restore control plus media authority');
    assert(schemaStatements.some(statement=>statement.startsWith('CREATE TABLE IF NOT EXISTS retention_scan_cursors(')));
  }finally{await engine.close();}
});

test('retention classes and sources keep independent nullable continuation tuples and reject invalid cursors',async()=>{
  const engine=await baseline();
  try{
    await engine.exec(migration);await engine.exec('SET ROLE lovelies_api');
    for(const scan of ['support','guardian','adult','privacy'])await engine.query(
      'INSERT INTO lovelies_private.retention_scan_cursors(scan,last_at,last_id) VALUES($1,NULL,NULL)',[scan]);
    await engine.exec("UPDATE lovelies_private.retention_scan_cursors SET last_at=1000,last_id='support-last-examined' WHERE scan='support' AND entity_id=''");
    const rows=(await engine.query("SELECT scan,entity_id,last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE entity_id='' ORDER BY scan")).rows;
    assert.deepEqual(rows.map(row=>({...row,last_at:row.last_at===null?null:Number(row.last_at)})),[
      {scan:'adult',entity_id:'',last_at:null,last_id:null},{scan:'guardian',entity_id:'',last_at:null,last_id:null},
      {scan:'privacy',entity_id:'',last_at:null,last_id:null},{scan:'support',entity_id:'',last_at:1000,last_id:'support-last-examined'}]);
    await engine.exec(`INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES
      ('adult','review-one',2000,'operation-one'),('adult','review-two',3000,'operation-two');
      INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('adult','review-one',4000,'operation-three')
        ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id;`);
    const receipts=(await engine.query("SELECT entity_id,last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE scan='adult' AND entity_id<>'' ORDER BY entity_id")).rows;
    assert.deepEqual(receipts.map(row=>({...row,last_at:Number(row.last_at)})),[
      {entity_id:'review-one',last_at:4000,last_id:'operation-three'},
      {entity_id:'review-two',last_at:3000,last_id:'operation-two'}]);
    assert.deepEqual((await engine.query("SELECT last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE scan='adult' AND entity_id=''")).rows[0],{last_at:null,last_id:null},'receipt continuation leaves the class cursor unchanged');
    await assert.rejects(()=>engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan) VALUES('photos')"),/check constraint/);
    await assert.rejects(()=>engine.exec("UPDATE lovelies_private.retention_scan_cursors SET last_at=2000 WHERE scan='adult' AND entity_id=''"),/check constraint/);
    await assert.rejects(()=>engine.exec("UPDATE lovelies_private.retention_scan_cursors SET last_id='partial' WHERE scan='guardian' AND entity_id=''"),/check constraint/);
    await assert.rejects(()=>engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id) VALUES('adult',NULL)"),/not-null constraint/);
    await assert.rejects(()=>engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id,last_id) VALUES('adult','partial-review','partial')"),/check constraint/);
    await assert.rejects(()=>engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id) VALUES('adult','review-one')"),/duplicate key/);
    await assert.rejects(()=>engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan) VALUES('support')"),/duplicate key/);
    await engine.exec("UPDATE lovelies_private.retention_scan_cursors SET last_at=NULL,last_id=NULL WHERE scan='support' AND entity_id=''");
    assert.equal(Number((await engine.query("SELECT count(*) n FROM lovelies_private.retention_scan_cursors WHERE entity_id='' AND last_at IS NULL AND last_id IS NULL")).rows[0].n),4);
  }finally{await engine.close();}
});

test('v11 refuses an unprepared v9 baseline without creating a cursor table or marker',async()=>{
  const engine=await baseline(9);
  try{
    await assert.rejects(()=>engine.exec(migration),/retention_scan_cursors_requires_schema_v10/);
    assert.equal((await engine.query("SELECT to_regclass('lovelies_private.retention_scan_cursors') table_name")).rows[0].table_name,null);
    await engine.exec('SET ROLE lovelies_api');
    assert.equal(Number((await engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),9);
  }finally{await engine.close();}
});
