import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, type Binding, type Database, type InvocationAuthorityOutcomeCode } from './types.ts';
import { RestoreTransactionCollector, type RestoreTransactionScope } from './restore-transaction.ts';

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

/** Independent restore admission is deliberately an injected production port;
 * a missing database control row is never created by request handling. */
export interface DatabaseFence {
  enter(connection:SqlConnection):Promise<unknown>;
  lineage(admission:unknown):DatabaseLineage;
  prepare(connection:SqlConnection,admission:unknown,intent?:unknown):Promise<unknown>;
  committed(connection:SqlConnection,prepared:unknown):Promise<void>;
}
export type DatabaseLineage=Readonly<{database_id:string;incarnation_id:string}>;
type TransactionFrame={connection:SqlConnection;readOnly:boolean;restore:RestoreTransactionScope};
type InvocationAuthority={check:()=>Promise<void>;fresh:()=>void;outcomeCode:InvocationAuthorityOutcomeCode};
type InvocationFrame={lineage?:DatabaseLineage;closed:boolean;failed:boolean;failureCode?:string;
  authority?:InvocationAuthority;mayHaveCommitted?:boolean};
const lineageID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every mutation runs on one reserved PostgreSQL connection. The advisory lock
 * retains the original engine's single-authority serialization across isolates.
 * AsyncLocalStorage scopes the connection to its callback; parallel requests
 * cannot accidentally join another request's transaction. Never automatically
 * retry a callback: it could include a deliberately prepared external effect. */
export class PostgresDatabase implements Database {
  private readonly transactions=new AsyncLocalStorage<TransactionFrame>();
  private readonly invocations=new AsyncLocalStorage<InvocationFrame>();
  constructor(private readonly connection:SqlConnection,private readonly fence?:DatabaseFence){}
  private unavailable(frame=this.invocations.getStore()):never {
    if(frame)frame.failed=true;
    throw new ApiError(503,frame?.failureCode??'restore_reconciliation_required');
  }
  private authorityError(frame:InvocationFrame,error:unknown):never {
    // Once a guarded write may have reached an independent prepare or SQL
    // COMMIT, expired authority cannot prove that the operation did not run.
    if(frame.mayHaveCommitted){frame.failureCode=frame.authority?.outcomeCode??'store_operation_outcome_unresolved';return this.unavailable(frame);}
    throw error;
  }
  private async checkBoundAuthority(frame:InvocationFrame):Promise<void> {
    if(!frame.authority)return;
    try{await frame.authority.check();frame.authority.fresh();}
    catch(error){return this.authorityError(frame,error);}
  }
  private checkBoundFreshness(frame:InvocationFrame):void {
    if(!frame.authority)return;
    try{frame.authority.fresh();}
    catch(error){return this.authorityError(frame,error);}
  }
  /** Only the selected request installs this; terminal/self-revocation and
   * anonymous routes retain their existing invocation semantics. */
  bindInvocationAuthority(check:()=>Promise<void>,fresh:()=>void,outcomeCode:InvocationAuthorityOutcomeCode='store_operation_outcome_unresolved'):void {
    const frame=this.assertInvocation();
    if(!frame||frame.authority||this.transactions.getStore()||typeof check!=='function'||typeof fresh!=='function'||
      !['store_operation_outcome_unresolved','privacy_export_grant_outcome_unresolved'].includes(outcomeCode))
      throw new ApiError(500,'invocation_authority_invalid');
    frame.authority=Object.freeze({check,fresh,outcomeCode});
  }
  private assertInvocation():InvocationFrame|undefined {
    const frame=this.invocations.getStore();
    if(frame&&(frame.closed||frame.failed))return this.unavailable(frame);
    return frame;
  }
  private admitInvocation(admission:unknown):void {
    const frame=this.assertInvocation();
    if(!frame||!this.fence)return;
    const next=this.fence.lineage(admission);
    if(!next||Object.keys(next).sort().join(',')!=='database_id,incarnation_id'||
      !lineageID.test(next.database_id)||!lineageID.test(next.incarnation_id))return this.unavailable(frame);
    if(frame.lineage&&(frame.lineage.database_id!==next.database_id||frame.lineage.incarnation_id!==next.incarnation_id))return this.unavailable(frame);
    frame.lineage??=Object.freeze({database_id:next.database_id,incarnation_id:next.incarnation_id});
  }
  /** One logical request/job retains its first independently admitted lineage
   * across SQL transactions and awaited external work. Nested calls join it;
   * neither a caught mismatch nor an escaped callback can open a fresh scope. */
  async invocation<T>(callback:()=>T|Promise<T>):Promise<T> {
    if(this.assertInvocation()){
      const value=await callback();this.assertInvocation();return value;
    }
    // The final admission must be a fresh transaction, not a joined transaction
    // whose admission happened before this logical invocation began.
    if(this.transactions.getStore())throw new ApiError(500,'database_invocation_scope_invalid');
    const frame:InvocationFrame={closed:false,failed:false};
    return this.invocations.run(frame,async()=>{
      try{
        const value=await callback();this.assertInvocation();
        // The actor check runs inside the final independently admitted read.
        // Repeat its synchronous deadline check after that transaction closes.
        if(frame.lineage||frame.authority)await this.read(()=>this.checkBoundAuthority(frame));
        this.assertInvocation();this.checkBoundFreshness(frame);return value;
      }catch(error){
        // A privacy grant may have committed even when a subsequent handler read
        // raises session_invalid. Do not send a definitive failure that permits
        // the client to discard its exact recovery key.
        if(frame.mayHaveCommitted&&frame.authority?.outcomeCode==='privacy_export_grant_outcome_unresolved'){
          frame.failureCode=frame.authority.outcomeCode;return this.unavailable(frame);
        }
        throw error;
      }finally{frame.closed=true;}
    });
  }
  async all<T=Record<string,unknown>>(source:string,...bindings:Binding[]):Promise<T[]> {
    this.assertInvocation();
    if(bindings.length>100)throw new ApiError(500,'sql_binding_limit');
    const {sql,values}=postgresQuery(source,bindings);
    const frame=this.transactions.getStore();
    if(!frame)return this.read(()=>this.all<T>(source,...bindings));
    const rows=await frame.connection.query<T>(sql,values);this.assertInvocation();return rows;
  }
  async one<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T|null> {
    const rows=await this.all<T>(sql,...bindings);
    if(rows.length>1)throw new ApiError(500,'non_unique_database_row');return rows[0]??null;
  }
  async run(sql:string,...bindings:Binding[]):Promise<void> {
    this.assertInvocation();
    if(!this.transactions.getStore()){await this.transaction(()=>this.run(sql,...bindings));return;}
    if(this.transactions.getStore()!.readOnly)throw new ApiError(500,'read_only_transaction');
    await this.all(sql,...bindings);
  }
  async read<T>(callback:()=>T|Promise<T>):Promise<T>{
    this.assertInvocation();
    if(this.transactions.getStore()){const value=await callback();this.assertInvocation();return value;}
    return this.execute(callback,true);
  }
  async transaction<T>(callback:(restore:RestoreTransactionScope)=>T|Promise<T>,intent?:unknown):Promise<T> {
    this.assertInvocation();
    const active=this.transactions.getStore();
    if(active){
      if(active.readOnly)throw new ApiError(500,'read_only_transaction');
      // A nested callback cannot install a different independent operation.
      if(intent!==undefined)throw new ApiError(500,'nested_restore_operation');
      const value=await callback(active.restore);this.assertInvocation();return value;
    }
    return this.execute(callback,false,intent);
  }
  private async execute<T>(callback:(restore:RestoreTransactionScope)=>T|Promise<T>,readOnly:boolean,intent?:unknown):Promise<T>{
    this.assertInvocation();
    let prepared:unknown,commitDispatched=false,result:T;
    const collector=new RestoreTransactionCollector(readOnly,intent!==undefined),restore=collector.scope;
    try{result=await this.connection.begin(connection=>this.transactions.run({connection,readOnly,restore},async()=>{
      try{
        // This is enforced by PostgreSQL, including modifying CTEs and volatile
        // functions. SQL spelling/method names cannot prove a query read-only.
        if(readOnly)await connection.query('SET TRANSACTION READ ONLY',[]);
        await connection.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);
        await connection.query('SET LOCAL ROLE lovelies_api',[]);
        await connection.query("SET LOCAL search_path TO lovelies_private, pg_catalog",[]);
        let admission:unknown;
        try{admission=await this.fence?.enter(connection);this.admitInvocation(admission);}
        catch(error){const frame=this.invocations.getStore();if(frame)frame.failed=true;throw error;}
        const value=await callback(restore);
        this.assertInvocation();
        const manifest=await collector.seal(intent);
        this.assertInvocation();
        const invocation=this.invocations.getStore();
        if(!readOnly&&invocation?.authority)await this.checkBoundAuthority(invocation);
        // SQL remains uncommitted until independent acknowledgement. Domain
        // effects must register exact restrictions and external ports must fence
        // effects; this adapter never automatically reruns a callback on error.
        if(this.fence&&!readOnly){
          // The independent plan may be accepted even if its reply is lost.
          if(invocation?.authority)invocation.mayHaveCommitted=true;
          try{prepared=await this.fence.prepare(connection,admission,manifest);}
          catch(error){const frame=this.invocations.getStore();if(frame)frame.failed=true;throw error;}
          // This query runs on the still-open SQL transaction after prepare.
          // Expiry rolls back SQL while preserving the independent plan.
          if(invocation?.authority)await this.checkBoundAuthority(invocation);
        }
        this.assertInvocation();
        // Last synchronous check before returning to the SQL COMMIT port.
        // Even without a journal, that COMMIT can have an ambiguous outcome.
        if(!readOnly&&invocation?.authority){
          invocation.mayHaveCommitted=true;this.checkBoundFreshness(invocation);commitDispatched=true;
        }
        return value;
      }finally{collector.close();}
    }));}catch(error){
      const invocation=this.invocations.getStore();
      // Once the callback has returned for COMMIT, a lost reply cannot prove
      // that SQL rolled back. Preserve any accepted independent plan.
      if(commitDispatched&&invocation?.authority){
        invocation.failureCode=invocation.authority.outcomeCode;return this.unavailable(invocation);
      }
      throw error;
    }
    if(this.fence&&prepared!==undefined){
      // The first transaction may have committed while its acknowledgement was
      // lost or taken over by another pool. Reacquire the same lock and reread
      // the actual PG marker; a cached pre-restore successor is insufficient.
      this.assertInvocation();
      try{await this.connection.begin(async connection=>{
        await connection.query('SET TRANSACTION READ ONLY',[]);
        await connection.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);
        await connection.query('SET LOCAL ROLE lovelies_api',[]);
        await connection.query("SET LOCAL search_path TO lovelies_private, pg_catalog",[]);
        await this.fence!.committed(connection,prepared);
      });}catch(error){const frame=this.invocations.getStore();if(frame)frame.failed=true;throw error;}
    }
    this.assertInvocation();
    // COMMIT or independent acknowledgement may have outlived the session.
    // Re-admit the same lineage and actor before this write result is released.
    const invocation=this.invocations.getStore();
    if(!readOnly&&invocation?.authority){
      await this.read(()=>this.checkBoundAuthority(invocation));
      this.assertInvocation();this.checkBoundFreshness(invocation);
    }
    this.assertInvocation();return result;
  }
  async close():Promise<void>{await this.connection.close?.();}
}

export function connectPostgres(url:string,rootCertificate?:string,fence?:DatabaseFence):PostgresDatabase {
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
  return new PostgresDatabase(connection,fence);
}
