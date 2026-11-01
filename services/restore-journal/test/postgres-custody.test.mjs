import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createNativeCustodyFixture} from './native-custody-fixture.mjs';
import {createPostgresStorage,custodyConnectionOptions} from '../src/postgres-storage.mjs';
import {appendEvent,readEvents,readHead,PROJECT_ID} from '../src/journal.mjs';
import {bootstrapControl,prepareOperation,acknowledgeOperation,admitDatabase,readControl} from '../src/operations.mjs';
import {journalHandler} from '../src/server.mjs';
import {event,env as journalEnv} from './fixtures.mjs';
import {handleLedgerRequest,PUSH_LEDGER_PROJECT} from '../../push-provider/src/durable-ledger.mjs';
import {canonical,sha256,PUSH_PLAN_PROTOCOL} from '../../push-provider/src/push-plan.mjs';

const wrap=client=>({query:async(text,values=[]) => (await client.query(text,values)).rows,
  transaction:callback=>client.transaction(inner=>callback(wrap(inner)))});
const schema=new URL('../../../deploy/local-supabase/custody-schema.sql',import.meta.url);

test('PostgreSQL custody preserves journal and v2 push authority',async t=>{
 const pg=process.env.TEST_DATABASE_URL?await createNativeCustodyFixture():new PGlite();await pg.waitReady;
 t.after(()=>pg.close());
 await pg.exec(await readFile(schema,'utf8'));
 // Every runtime statement uses the actual narrow role, including health.
 const rolePort=role=>({
  query:async(text,values=[])=>pg.transaction(async inner=>{await inner.exec('SET LOCAL ROLE '+role);return (await inner.query(text,values)).rows;}),
  transaction:callback=>pg.transaction(async inner=>{await inner.exec('SET LOCAL ROLE '+role);return callback(wrap(inner));}),
 });
 const database=rolePort('lovelies_journal'),pushDatabase=rolePort('lovelies_push'),journal=createPostgresStorage(database,'restore_journal'),push=createPostgresStorage(pushDatabase,'push_receipts');
 await t.test('schema and separate role privileges are enforced',async()=>{
  assert.equal(await journal.health(),true);assert.equal(await push.health(),true);
  await pg.exec('SET ROLE lovelies_journal');
  try{
   assert.equal((await pg.query('SELECT count(*) n FROM restore_journal.kv')).rows[0].n,0);
   await assert.rejects(pg.query('SELECT * FROM push_receipts.kv'),error=>error.code==='42501');
   await assert.rejects(pg.exec('CREATE TABLE restore_journal.forbidden(id integer)'),error=>error.code==='42501');
  }finally{await pg.exec('RESET ROLE');}
 });
 await t.test('authentication and bootstrap authority precede persistence',async()=>{
  let calls=0;const storage={transaction:()=>{calls++;throw Error('must not run');}};
  const handler=journalHandler(storage,{...journalEnv,RESTORE_JOURNAL_BOOTSTRAP_TOKEN:'synthetic-independent-operator-bootstrap-token'});
  assert.equal((await handler(new Request('https://journal.invalid/v1/head'))).status,401);
  assert.equal((await handler(new Request('https://journal.invalid/v1/control/bootstrap',{method:'POST',headers:{authorization:'Bearer '+journalEnv.RESTORE_JOURNAL_TOKEN,'content-type':'application/json'},body:'{}'}))).status,401);
  assert.equal(calls,0);
 });
 await t.test('concurrent exact events have one receipt and rollback cannot leak facts',async()=>{
  const input=event();const receipts=await Promise.all(Array.from({length:8},()=>appendEvent(journal,input)));
  receipts.forEach(value=>assert.deepEqual(value,receipts[0]));assert.equal((await readHead(journal)).sequence,1);
  // Preserve JSON types across the driver boundary, including a legitimate
  // string that looks like JSON. Readback must never repair strings by parsing.
  const values={'json-probe:object':{version:1,nested:[true,null,'quoted " value','back\\slash','\u00e9']},'json-probe:array':[1,false,null],
   'json-probe:string':'{"literal":true}','json-probe:null':null,'json-probe:boolean':true,'json-probe:number':7};
  for(const [storage,port,namespace] of [[journal,database,'restore_journal'],[push,pushDatabase,'push_receipts']]){
   await storage.transaction(async tx=>{await tx.put(values);for(const [name,value] of Object.entries(values))assert.deepEqual(await tx.get(name),value);
    assert.deepEqual(Object.fromEntries(await tx.list({prefix:'json-probe:'})),values);});
   const types=await port.query(`SELECT key,jsonb_typeof(value) AS type FROM ${namespace}.kv WHERE key LIKE 'json-probe:%' ORDER BY key`);
   assert.deepEqual(Object.fromEntries(types.map(row=>[row.key,row.type])),Object.fromEntries(Object.keys(values).map(name=>[name,name.slice('json-probe:'.length)])));
  }
  // These are isolated fixture records, removed before the ledger bootstrap.
  await pg.exec('TRUNCATE push_receipts.kv');
  await assert.rejects(journal.transaction(async tx=>{await tx.put({'event:9999999999999999':{synthetic:true}});throw Error('rollback');}));
  assert.equal(await journal.transaction(tx=>tx.get('event:9999999999999999')),undefined);
  const stored=(await readEvents(journal,0,10)).events;
  assert.equal(stored.length,1);
  await assert.rejects(pg.query("UPDATE restore_journal.kv SET value='{}' WHERE key=$1",['event:0000000000000001']),error=>error.code==='55000');
 });
 await t.test('committed successor persists and an older app marker fences serving',async()=>{
  // Reset only this newly created in-memory synthetic database between scenarios.
  await pg.exec('TRUNCATE restore_journal.kv');
  const envelope=fields=>({version:1,project_id:PROJECT_ID,...fields});
  const initial=await bootstrapControl(journal,envelope({database_id:randomUUID(),bootstrap_id:randomUUID()}));
  const old=initial.binding.initial_marker;
  const operation=await prepareOperation(journal,envelope({operation_id:randomUUID(),input_hash:'a'.repeat(64),expected:old,allocations:{},events:[]}));
  assert.equal(operation.control.state,'pending');
  await assert.rejects(admitDatabase(journal,envelope({marker:old})),error=>error.code==='operation_pending');
  await acknowledgeOperation(journal,operation.operation.plan.operation_id,envelope({plan_hash:operation.operation.plan_hash,marker:operation.operation.plan.next}));
  const restarted=createPostgresStorage(database,'restore_journal');
  assert.equal((await admitDatabase(restarted,envelope({marker:operation.operation.plan.next}))).admitted,true);
  await assert.rejects(admitDatabase(restarted,envelope({marker:old})),error=>error.code==='serving_quarantined');
  assert.equal((await readControl(createPostgresStorage(database,'restore_journal'))).control.state,'quarantined');
 });
 const ledgerID=randomUUID(),bootstrapID=randomUUID(),generation='a'.repeat(64),token='synthetic-runtime-ledger-token-32-characters',bootstrapToken='synthetic-operator-ledger-token-32-characters';
 const env={SUPABASE_PROJECT_ID:PUSH_LEDGER_PROJECT,PUSH_LEDGER_ID:ledgerID,PUSH_LEDGER_TOKEN:token,PUSH_LEDGER_BOOTSTRAP_TOKEN:bootstrapToken};
 let now=1_800_000_000_000;
 const send=async(path,value,operator=false)=>{
  const result=await handleLedgerRequest(new Request('https://ledger.invalid'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+(operator?bootstrapToken:token),...(value===undefined?{}:{'content-type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)})}),env,push,{now:()=>now});
  return {status:result.status,value:await result.json()};
 };
 const v1=fields=>({version:1,project_id:PUSH_LEDGER_PROJECT,ledger_id:ledgerID,...fields});
 const v2=fields=>({version:2,project_id:PUSH_LEDGER_PROJECT,ledger_id:ledgerID,...fields});
 await t.test('explicit v1 and v2 bootstrap is idempotent and retires old senders',async()=>{
  const initial=await send('/v1/bootstrap',v1({bootstrap_id:randomUUID()}),true);assert.equal(initial.status,200,JSON.stringify(initial));
  const initialized=await send('/v2/bootstrap',v2({bootstrap_id:bootstrapID,provider_generation:generation}),true);assert.equal(initialized.status,200,JSON.stringify(initialized));
  assert.deepEqual(await send('/v2/bootstrap',v2({bootstrap_id:bootstrapID,provider_generation:generation}),true),initialized);
  const id=randomUUID();
  assert.equal((await send('/v1/operations/reserve',v1({operation_key:'notification:'+id+':'+randomUUID(),notification_id:id,request_sha256:'b'.repeat(64),platform:'android'}))).value.error,'ledger_protocol_retired');
 });
 await t.test('durable v2 plan keeps ambiguous sends fenced and cancels unstarted attempts',async()=>{
  const id=randomUUID(),subject='b'.repeat(64);
  const attempts=[randomUUID(),randomUUID()].map(device=>({operation_key:'notification:'+id+':'+device,device_id:device,platform:'android',request_sha256:'c'.repeat(64),token_sha256:'d'.repeat(64)})).sort((a,b)=>a.operation_key.localeCompare(b.operation_key));
  const plan={protocol:PUSH_PLAN_PROTOCOL,ledger_id:ledgerID,ledger_bootstrap_id:bootstrapID,notification_id:id,subject_sha256:subject,provider_generation:generation,attempts};
  const hash=await sha256(canonical(plan));
  const admitted=await send('/v2/plans',v2({plan,plan_sha256:hash}));assert.equal(admitted.status,200,JSON.stringify(admitted));
  const entry=attempts[0],path='/v2/operations/'+encodeURIComponent(entry.operation_key);
  const reserved=await send('/v2/operations/reserve',v2({operation_key:entry.operation_key,plan_sha256:hash,request_sha256:entry.request_sha256,provider_generation:generation}));
  assert.equal(reserved.status,200,JSON.stringify(reserved));
  const started=await send(path+'/start',v2({claim_id:reserved.value.result.claim,provider_generation:generation}));assert.equal(started.status,200,JSON.stringify(started));
  assert.equal(started.value.result.receipt.status,'dispatching');
  now+=61_000;
  assert.equal((await send(path)).value.result.receipt.status,'ambiguous');
  assert.equal((await send('/v2/subjects/'+subject+'/retire',v2({}))).status,200);
  const after=await send('/v2/plans/'+id);
  assert.equal(after.value.result.receipts[0].status,'ambiguous');assert.equal(after.value.result.receipts[1].status,'cancelled');
  await send('/v2/fence',v2({reason:'provider_generation_retirement'}));
  const blocked=await send('/v2/generations/activate',v2({previous_generation:generation,provider_generation:'e'.repeat(64)}),true);
  assert.equal(blocked.value.error,'push_generation_reconciliation_required');
  const finished=await send(path+'/finish',v2({result:{status:'accepted',provider_message_id:'synthetic-provider-receipt'}}));assert.equal(finished.status,200,JSON.stringify(finished));
  assert.equal((await send(path)).value.result.receipt.status,'accepted');
  await assert.rejects(pg.exec('DELETE FROM push_receipts.push_roster_intents_v2'),error=>error.code==='55000');
  const changed=await send('/v2/generations/activate',v2({previous_generation:generation,provider_generation:'e'.repeat(64)}),true);assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal((await send(path)).value.result.receipt.status,'accepted');
 });
});

test('database TLS is verified unless an exact private host is explicitly selected',async()=>{
 const env={CUSTODY_DATABASE_URL:'postgres://lovelies_journal:synthetic-private-password@custody-db:5432/postgres',CUSTODY_DATABASE_TLS_MODE:'verify-full'};
 assert.equal((await custodyConnectionOptions(env)).options.ssl.rejectUnauthorized,true);
 await assert.rejects(custodyConnectionOptions({...env,CUSTODY_DATABASE_TLS_MODE:'disable-internal'}));
 assert.equal((await custodyConnectionOptions({...env,CUSTODY_DATABASE_TLS_MODE:'disable-internal',CUSTODY_DATABASE_TRUSTED_HOSTS:'custody-db'})).options.ssl,false);
 await assert.rejects(custodyConnectionOptions({...env,CUSTODY_DATABASE_URL:'postgres://postgres:password@custody-db/postgres'}));
 await assert.rejects(custodyConnectionOptions({...env,CUSTODY_DATABASE_URL:env.CUSTODY_DATABASE_URL+'?sslmode=disable'}));
});
