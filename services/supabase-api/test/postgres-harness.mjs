import postgres from 'postgres';

/** This path is only for the explicitly disposable local PostgreSQL container.
 * Every harness gets a new database; existing databases/schemas are never reset.
 * Test credentials are read from the process environment and never printed. */
export async function isolatedPostgres(url){
 const target=new URL(url);
 if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname))throw new Error('Local disposable PostgreSQL test target required');
 const options={prepare:false,max:1,ssl:false,onnotice:()=>{},types:{bigint:{to:20,from:[20],serialize:String,parse:value=>{
  const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('Unsafe test database integer');return number;
 }}}};
 const administrator=postgres(url,options),name='lovelies_test_'+crypto.randomUUID().replaceAll('-','');
 let sql;
 try{
  // Roles are cluster-scoped; sequential test harnesses reuse the validated
  // private backend role while their account/media tables remain isolated.
  await administrator.unsafe("DO $roles$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $roles$");
  await administrator.unsafe('CREATE DATABASE '+name);
  const databaseUrl=new URL(url);databaseUrl.pathname='/'+name;
  sql=postgres(databaseUrl.href,options);
  return {url:databaseUrl.href,engine:{
   query:async(source,bindings=[])=>({rows:await sql.unsafe(source,bindings)}),
   exec:source=>sql.unsafe(source),
   close:async()=>{await sql.end({timeout:5});await administrator.unsafe('DROP DATABASE '+name);await administrator.end({timeout:5});},
  }};
 }catch(error){await sql?.end({timeout:5});await administrator.end({timeout:5});throw error;}
}
