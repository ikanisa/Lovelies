import { stable, type Binding, type Database, type AppContext } from './types.ts';
import type { SqlConnection } from './database.ts';
import { retiredOperationInput, retiredOperationResponse } from './operations.ts';
import type { RestoreOperationRecord } from './restore-journal.ts';
import { DOWNLOAD_SOURCE, downloadUnresolved, verifyDownloadDescriptor, verifyDownloadSeal,
  type DownloadEvidence, type DownloadKeyConfiguration, type DownloadSeal } from './download-v2-contract.ts';

export type DownloadSql = Pick<SqlConnection,'query'>;
export type DownloadProof = { evidence: DownloadEvidence; seal: DownloadSeal };
export function downloadSql(db:Database):DownloadSql {
  return {query:<T>(sql:string,bindings:unknown[])=>db.all<T>(sql.replace(/\$[0-9]+/g,'?'),...bindings as Binding[])};
}
/** Never interpret missing/corrupt evidence as a terminal negative receipt. */
export async function loadDownloadProof(sql:DownloadSql,keys:DownloadKeyConfiguration,operationID:string):Promise<DownloadProof|null> {
  const rows=await sql.query<any>('SELECT operation_id,account_id,operation_key,asset_id,disposition,receipt_json,receipt_hash,recorded_at,retired_at FROM download_v2_operations WHERE operation_id=$1',[operationID]);
  if(rows.length===0)return null;if(rows.length!==1)return downloadUnresolved();const row=rows[0];
  let seal:DownloadSeal;try{seal=JSON.parse(row.receipt_json);}catch{return downloadUnresolved();}
  const e=await verifyDownloadSeal(keys,seal);
  if(stable(seal)!==row.receipt_json||row.retired_at!==null||row.recorded_at!==e.recorded_at||row.operation_id!==e.operation_id||row.account_id!==e.context.account_id||
    row.operation_key!==e.context.operation_key||row.asset_id!==e.context.asset_id||row.disposition!==e.disposition||row.receipt_hash!==seal.receipt_hash)return downloadUnresolved();
  const tickets=await sql.query<any>('SELECT id,operation_id,receipt_hash FROM download_v2_tickets WHERE operation_id=$1 OR id=$2',[operationID,e.ticket_id]);
  const operations=await sql.query<any>('SELECT source,action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=$1 AND operation_key=$2',[e.context.account_id,e.context.operation_key]);
  const downloads=operations.filter((r:any)=>r.source===DOWNLOAD_SOURCE||r.action==='download.sign'||r.action==='download.sign.v2');
  if(e.disposition==='not_issued'){
    if(tickets.length||downloads.length)return downloadUnresolved();
  }else{
    if(tickets.length!==1||tickets[0].id!==e.ticket_id||tickets[0].operation_id!==operationID||tickets[0].receipt_hash!==seal.receipt_hash||
      downloads.length!==1||downloads[0].source!==DOWNLOAD_SOURCE||downloads[0].action!=='download.sign.v2'||downloads[0].payload_hash!==e.input_hash||
      downloads[0].payload_json!==stable(e.context)||downloads[0].response_json!==stable(e.wire))return downloadUnresolved();
  }
  return {evidence:e,seal};
}
export async function bindDownloadProof(operation:RestoreOperationRecord,proof:DownloadProof):Promise<void> {
  if(!operation.plan.download)return downloadUnresolved();const d=await verifyDownloadDescriptor(operation.plan.download,operation.plan),e=proof.evidence;
  if(e.operation_id!==operation.plan.operation_id||e.input_hash!==operation.plan.input_hash||e.ticket_id!==d.ticket_id||e.recorded_at!==JSON.parse(d.not_issued.evidence_json).recorded_at||
    stable(e.context)!==stable(d.context)||stable(e.expected)!==stable(operation.plan.expected)||
    proof.seal.receipt_hash!==(e.disposition==='issued'?d.issued_receipt_hash:d.not_issued.receipt_hash)||
    e.disposition==='not_issued'&&stable(proof.seal)!==stable(d.not_issued)||
    operation.status==='committed'&&(operation.disposition!==e.disposition||operation.receipt_hash!==proof.seal.receipt_hash))return downloadUnresolved();
}
export async function writeDownloadEvidence(sql:DownloadSql,proof:DownloadProof):Promise<void>{
  const {evidence:e,seal}=proof;
  await sql.query('INSERT INTO download_v2_operations(operation_id,account_id,operation_key,asset_id,disposition,receipt_json,receipt_hash,recorded_at,retired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',
    [e.operation_id,e.context.account_id,e.context.operation_key,e.context.asset_id,e.disposition,stable(seal),seal.receipt_hash,e.recorded_at]);
}
/** A predecessor is abortable only for this typed plan and with no related SQL
 * evidence whatsoever. A random/conflicting row is preserved and holds serving. */
export async function assertDownloadAbsent(sql:DownloadSql,operation:RestoreOperationRecord):Promise<void>{
  const d=operation.plan.download;if(!d||operation.status!=='pending')return downloadUnresolved();
  for(const [query,bindings] of [
    ['SELECT operation_id FROM download_v2_operations WHERE operation_id=$1 OR (account_id=$2 AND operation_key=$3)',[operation.plan.operation_id,d.context.account_id,d.context.operation_key]],
    ['SELECT id FROM download_v2_tickets WHERE operation_id=$1 OR id=$2',[operation.plan.operation_id,d.ticket_id]],
    ['SELECT operation_key FROM operations WHERE actor_id=$1 AND operation_key=$2',[d.context.account_id,d.context.operation_key]],
    ['SELECT id FROM download_records WHERE ticket_id=$1',[d.ticket_id]],
    ['SELECT id FROM download_tickets WHERE id=$1',[d.ticket_id]],
  ] as Array<[string,unknown[]]>)if((await sql.query(query,bindings)).length)return downloadUnresolved();
}
/** Retire secret-bound authority material, retaining only independently bound
 * disposition/hash. No FK from this evidence prevents account/asset erasure. */
export async function retireDownloadEvidence(ctx:AppContext,subject:string,asset=false):Promise<void>{
  const db=ctx.db,predicate=asset?'asset_id=?':'account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)';
  const args=asset?[subject]:[subject,subject];let after='';
  for(;;){
    const rows=await db.all<any>('SELECT * FROM download_v2_operations WHERE ('+predicate+') AND operation_id>? ORDER BY operation_id LIMIT 100',...args,after);
    if(!rows.length)return;
    for(const row of rows){
      const independent=await db.verifiedRestoreOperation(row.operation_id);
      if(!independent?.plan.download||independent.status!=='committed'||independent.disposition!==row.disposition||independent.receipt_hash!==row.receipt_hash)return downloadUnresolved();
      const d=independent.plan.download,absent=await verifyDownloadSeal(ctx.env,d.not_issued);
      if(row.account_id!==d.context.account_id||row.operation_key!==d.context.operation_key||row.asset_id!==d.context.asset_id||row.recorded_at!==absent.recorded_at)return downloadUnresolved();
      if(row.retired_at!==null){
        if(row.receipt_json!==null||!Number.isSafeInteger(row.retired_at)||row.retired_at<row.recorded_at||
          await db.one('SELECT id FROM download_v2_tickets WHERE operation_id=? OR id=?',row.operation_id,d.ticket_id))return downloadUnresolved();
        continue;
      }
      const proof=await loadDownloadProof(downloadSql(db),ctx.env,row.operation_id);if(!proof)return downloadUnresolved();await bindDownloadProof(independent,proof);
      await db.run('DELETE FROM download_v2_tickets WHERE operation_id=? AND receipt_hash=?',row.operation_id,row.receipt_hash);
      if(row.disposition==='issued')await db.run('UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source=? AND operation_key=? AND payload_json=? AND response_json=?',
        retiredOperationInput,retiredOperationResponse,row.account_id,DOWNLOAD_SOURCE,row.operation_key,stable(proof.evidence.context),stable(proof.evidence.wire));
      await db.run('UPDATE download_v2_operations SET receipt_json=NULL,retired_at=? WHERE operation_id=? AND receipt_json=? AND receipt_hash=? AND retired_at IS NULL',ctx.now(),row.operation_id,row.receipt_json,row.receipt_hash);
    }
    after=rows.at(-1).operation_id;
  }
}
