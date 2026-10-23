import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, type Binding, type Database } from './types.ts';

/** Only bound values cross this translator. SQL is static application source.
 * Quoted strings/comments/dollar strings never become parameter positions. */
export function postgresQuery(source:string, bindings: readonly Binding[]):{sql:string,values:unknown[]} {
  let sql='',index=0,i=0;
  while(i<source.length){
    const c=source[i];
    if(c==="'"||c==='"'){
      const quote=c;sql+=c;i++;
      while(i<source.length){const next=source[i++];sql+=next;if(next===quote){if(source[i]===quote){sql+=source[i++];}else break;}}
    }else if(source.slice(i,i+2)==='--'){
      const end=source.indexOf('\n',i);const until=end<0?source.length:end;sql+=source.slice(i,until);i=until;
    }else if(source.slice(i,i+2)==='/*'){
      const end=source.indexOf('*/',i+2);if(end<0)throw new ApiError(500,'invalid_application_sql');sql+=source.slice(i,end+2);i=end+2;
    }else if(c==='$'&&/^\$[A-Za-z_0-9]*\$/.test(source.slice(i))){
      const tag=/^\$[A-Za-z_0-9]*\$/.exec(source.slice(i))![0],end=source.indexOf(tag,i+tag.length);
      if(end<0)throw new ApiError(500,'invalid_application_sql');sql+=source.slice(i,end+tag.length);i=end+tag.length;
    }else if(c==='?'){
      if(index>=bindings.length)throw new ApiError(500,'sql_binding_mismatch');
      const value=bindings[index++];
      // An isolated NULL test has no column from which PostgreSQL can infer type.
      const cast=typeof value==='number'?'::bigint':typeof value==='string'?'::text':value===null&&/^\s+IS\s+(?:NOT\s+)?NULL\b/i.test(source.slice(i+1))?'::text':'';
      sql+=`$${index}${cast}`;i++;
    }else{sql+=c;i++;}
  }
  if(index!==bindings.length)throw new ApiError(500,'sql_binding_mismatch');
  if(/^\s*INSERT OR IGNORE\b/i.test(sql))sql=sql.replace(/INSERT OR IGNORE/i,'INSERT')+' ON CONFLICT DO NOTHING';
  // SQLite's two-argument scalar min has PostgreSQL's LEAST semantics here.
  sql=sql.replace(/min\(min\(coalesce/gi,'min(least(coalesce');
  return {sql,values:bindings.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value)};
}

export interface SqlConnection {
  query<T>(sql:string,bindings:unknown[]):Promise<T[]>;
  begin<T>(callback:(connection:SqlConnection)=>Promise<T>):Promise<T>;
  close?():Promise<void>;
}

/** Every mutation runs on one reserved PostgreSQL connection. The advisory lock
 * retains the original engine's single-authority serialization across isolates.
 * AsyncLocalStorage scopes the connection to its callback; parallel requests
 * cannot accidentally join another request's transaction. Never automatically
 * retry a callback: it could include a deliberately prepared external effect. */
export class PostgresDatabase implements Database {
  private readonly transactions=new AsyncLocalStorage<SqlConnection>();
  constructor(private readonly connection:SqlConnection){}
  async all<T=Record<string,unknown>>(source:string,...bindings:Binding[]):Promise<T[]> {
    if(bindings.length>100)throw new ApiError(500,'sql_binding_limit');
    const {sql,values}=postgresQuery(source,bindings);
    const connection=this.transactions.getStore();
    if(!connection)return this.transaction(()=>this.all<T>(source,...bindings));
    return connection.query<T>(sql,values);
  }
  async one<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T|null> {
    const rows=await this.all<T>(sql,...bindings);
    if(rows.length>1)throw new ApiError(500,'non_unique_database_row');return rows[0]??null;
  }
  async run(sql:string,...bindings:Binding[]):Promise<void> {
    if(!this.transactions.getStore()){await this.transaction(()=>this.run(sql,...bindings));return;}
    await this.all(sql,...bindings);
  }
  async transaction<T>(callback:()=>T|Promise<T>):Promise<T> {
    if(this.transactions.getStore())return await callback();
    return this.connection.begin(connection=>this.transactions.run(connection,async()=>{
      await connection.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);
      await connection.query('SET LOCAL ROLE lovelies_api',[]);
      await connection.query("SET LOCAL search_path TO lovelies_private, pg_catalog",[]);
      return await callback();
    }));
  }
  async close():Promise<void>{await this.connection.close?.();}
}

export function connectPostgres(url:string,rootCertificate?:string):PostgresDatabase {
  const target=new URL(url);
  if(!['postgres:','postgresql:'].includes(target.protocol))throw new Error('PostgreSQL URL required');
  const local=['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname);
  // Transaction-pooler safe: no named prepared statements/session state.
  const sql=postgres(url,{prepare:false,max:3,idle_timeout:20,connect_timeout:10,
    ssl:local?false:rootCertificate?{rejectUnauthorized:true,ca:rootCertificate}:'verify-full',connection:{search_path:'lovelies_private,pg_catalog',application_name:'lovelies-supabase-api'},
    types:{bigint:{to:20,from:[20],serialize:(value:unknown)=>String(value),parse:(value:string)=>{
      const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('Unsafe database integer');return number;
    }}},onnotice:()=>{}});
  const wrap=(query:typeof sql):SqlConnection=>({
    query:async<T>(source:string,values:unknown[])=>Array.from(await query.unsafe(source,values as never[]) as unknown as T[]),
    begin:async<T>(callback:(connection:SqlConnection)=>Promise<T>)=>await sql.begin(async tx=>callback(wrap(tx as unknown as typeof sql))) as T,
  });
  const connection=wrap(sql);connection.close=async()=>{await sql.end({timeout:5});};
  return new PostgresDatabase(connection);
}
