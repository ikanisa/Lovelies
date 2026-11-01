import assert from 'node:assert/strict';
import postgres from 'postgres';
import {isolatedPostgres} from '../../supabase-api/test/postgres-harness.mjs';

/** Opt-in native fixture. Every invocation creates its own new database, and
 * cleanup drops only that returned lovelies_test_UUID database. */
export async function createNativeCustodyFixture(){
 assert.equal(process.env.LOVELIES_DISPOSABLE_PG_TEST,'1','Explicit disposable PostgreSQL qualification is required');
 const target=new URL(process.env.TEST_DATABASE_URL);
 assert(['postgres:','postgresql:'].includes(target.protocol));
 assert(['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname));
 assert.equal(target.username,'postgres');assert.equal(target.pathname,'/postgres');
 assert(target.password&&!target.search&&!target.hash,'A local disposable administrator URL is required');
 const local=await isolatedPostgres(target.href);
 assert(/^\/lovelies_test_[0-9a-f]{32}$/.test(new URL(local.url).pathname));
 const sql=postgres(local.url,{prepare:false,max:1,ssl:false,onnotice:()=>{},
  types:{bigint:{to:20,from:[20],serialize:String,parse:value=>{const number=Number(value);assert(Number.isSafeInteger(number));return number;}}}});
 const wrap=connection=>({
  query:async(source,values=[])=>({rows:await connection.unsafe(source,values)}),
  exec:source=>connection.unsafe(source),
  transaction:callback=>connection.begin(inner=>callback(wrap(inner))),
 });
 return {...wrap(sql),waitReady:Promise.resolve(),close:async()=>{
  const errors=[];
  try{await sql.end({timeout:5});}catch(error){errors.push(error);}
  try{await local.engine.close();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Disposable native custody cleanup failed');
 }};
}
