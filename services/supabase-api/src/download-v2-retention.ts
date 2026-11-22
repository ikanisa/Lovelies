import { ApiError, stable, type AppContext } from './types.ts';
import { retiredOperationInput, retiredOperationResponse } from './operations.ts';
import { DOWNLOAD_SOURCE, downloadUnresolved, verifyDownloadSeal } from './download-v2-contract.ts';
import { bindDownloadProof, downloadSql, loadDownloadProof } from './download-v2-persistence.ts';

const DAY=86400000;
function subjects(value:unknown,result=new Set<string>()):Set<string>{
  if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){
    if(key.endsWith('_id')&&typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v))result.add(v);
    else if(v&&typeof v==='object')subjects(v,result);
  }return result;
}
async function held(ctx:AppContext,ids:string[]):Promise<boolean>{
  if((await ctx.db.one<{legal_hold:number}>("SELECT legal_hold FROM retention_settings WHERE id='default'"))?.legal_hold!==0)return true;
  const values=stable(ids);
  return !!(await ctx.db.one(`SELECT id FROM moderation_holds WHERE active=1 AND (subject_id IN(SELECT value FROM json_each(?)) OR asset_id IN(SELECT value FROM json_each(?))) LIMIT 1`,values,values))||
    !!(await ctx.db.one("SELECT id FROM privacy_requests WHERE request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled') AND subject_id IN(SELECT value FROM json_each(?)) LIMIT 1",values))||
    !!(await ctx.db.one("SELECT id FROM cleanup_intents WHERE status<>'verified' AND subject_id IN(SELECT value FROM json_each(?)) LIMIT 1",values));
}
/** Ordinary security authority copies use audit_days; minimal authenticated
 * recovery/privacy facts use the existing 365-day class. Unknown or corrupted
 * rows are preserved. This never changes an issuance disposition or journal. */
export async function pruneDownloadEvidence(ctx:AppContext,auditDays:number,maximum:number):Promise<void>{
  if(!Number.isSafeInteger(auditDays)||auditDays<1||auditDays>3650)return downloadUnresolved();
  const entity='download-v2-evidence',cursor=await ctx.db.one<{last_at:number|null;last_id:string|null}>("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?",entity);
  const at=cursor?.last_at??null,id=cursor?.last_id??null;
  if((at===null)!==(id===null)||at!==null&&(!Number.isSafeInteger(at)||at<0||typeof id!=='string'))return downloadUnresolved();
  const rows=await ctx.db.all<any>(`SELECT * FROM download_v2_operations WHERE recorded_at<=?
    ${at===null?'':'AND (recorded_at>? OR (recorded_at=? AND operation_id>?))'} ORDER BY recorded_at,operation_id LIMIT ?`,
    ctx.now()-Math.min(auditDays,365)*DAY,...(at===null?[]:[at,at,id]),maximum);
  const changed=new Set<string>();
  for(const row of rows){
    const independent=await ctx.db.verifiedRestoreOperation(row.operation_id);if(!independent?.plan.download||independent.status!=='committed')continue;
    const d=independent.plan.download;
    let absent;try{absent=await verifyDownloadSeal(ctx.env,d.not_issued);}catch{continue;}
    if(absent.recorded_at!==row.recorded_at||d.context.account_id!==row.account_id||d.context.operation_key!==row.operation_key||d.context.asset_id!==row.asset_id||
      independent.disposition!==row.disposition||independent.receipt_hash!==row.receipt_hash)continue;
    let ids=[row.account_id,row.asset_id];
    if(row.retired_at===null){
      if(row.recorded_at>ctx.now()-auditDays*DAY)continue;
      let proof;try{proof=await loadDownloadProof(downloadSql(ctx.db),ctx.env,row.operation_id);if(!proof)continue;await bindDownloadProof(independent,proof);}catch{continue;}
      ids=[...subjects(proof.evidence)];if(await held(ctx,ids))continue;
      await ctx.db.run('DELETE FROM download_v2_tickets WHERE operation_id=?',row.operation_id);
      if(row.disposition==='issued')await ctx.db.run('UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source=? AND operation_key=? AND payload_json=? AND response_json=?',
        retiredOperationInput,retiredOperationResponse,row.account_id,DOWNLOAD_SOURCE,row.operation_key,stable(proof.evidence.context),stable(proof.evidence.wire));
      await ctx.db.run('UPDATE download_v2_operations SET receipt_json=NULL,retired_at=? WHERE operation_id=? AND receipt_json=? AND receipt_hash=? AND retired_at IS NULL',
        ctx.now(),row.operation_id,row.receipt_json,row.receipt_hash);
    }else if(row.recorded_at<=ctx.now()-365*DAY){
      if(!Number.isSafeInteger(row.retired_at)||row.retired_at<row.recorded_at||row.retired_at>ctx.now()||await held(ctx,ids))continue;
      // A conflicting leftover is unknown, never permission to erase it.
      if(await ctx.db.one('SELECT id FROM download_v2_tickets WHERE operation_id=?',row.operation_id))continue;
      const op=await ctx.db.one<any>('SELECT action,payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?',row.account_id,DOWNLOAD_SOURCE,row.operation_key);
      if(op&&(op.action!=='download.sign.v2'||op.payload_json!==retiredOperationInput||op.response_json!==retiredOperationResponse))continue;
      if(op)await ctx.db.run('DELETE FROM operations WHERE actor_id=? AND source=? AND operation_key=? AND payload_json=? AND response_json=?',
        row.account_id,DOWNLOAD_SOURCE,row.operation_key,retiredOperationInput,retiredOperationResponse);
      await ctx.db.run('DELETE FROM download_v2_operations WHERE operation_id=? AND receipt_hash=? AND receipt_json IS NULL AND retired_at=?',row.operation_id,row.receipt_hash,row.retired_at);
    }else continue;
    for(const subject of ids)changed.add(subject);
    if(await held(ctx,ids))throw new ApiError(409,'retention_hold_changed');
  }
  const last=rows.at(-1);
  await ctx.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id",entity,last?.recorded_at??null,last?.operation_id??null);
  if(changed.size)ctx.db.beforeCommit(async()=>{if(await held(ctx,[...changed]))throw new ApiError(409,'retention_hold_changed');});
}
