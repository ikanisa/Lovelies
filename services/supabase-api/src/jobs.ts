import { maintainAudience } from './audience.ts';
import { ApiError, digest, stable, record, type AppContext, type Database } from './types.ts';
import { cleanupFaceProofs } from './face-auth.ts';
import { finishLifecycleCleanup } from './face-profile.ts';
import { processPhotoJob, flushPhotoOutbox } from './processing.ts';
import { processPrivacyJob, flushPrivacyCleanup } from './privacy.ts';
import { processNotificationJob, flushNotificationOutbox } from './notifications.ts';
import { expireUploads } from './upload-transfers.ts';
import { runRetention } from './retention.ts';
import { pruneRefreshDeliveries } from './refresh-delivery.ts';

export class PostgresJobQueue {
  constructor(private readonly db:Database,private readonly now=Date.now){}
  async send(input:unknown):Promise<void>{
    const message=record(input);
    if(!['photo','privacy','notification'].includes(message.category)||!message.payload||Object.keys(message).some(key=>!['category','payload'].includes(key)))throw new ApiError(500,'invalid_job');
    const payload=stable(message.payload);if(payload.length>16384)throw new ApiError(500,'job_too_large');
    const id=await digest(stable(message));
    await this.db.run("INSERT INTO job_queue(id,category,payload_json,state,available_at,created_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING",id,message.category,payload,this.now(),this.now());
  }
}

type Job={id:string;category:string;payload_json:string;attempts:number;lease_token:string|null};
/** Leases survive isolate death. Commit-before-ack + stable IDs make queue delivery
 * at least once; each domain handler revalidates its own bound durable state. */
export async function drainJobs(ctx:AppContext,limit=8):Promise<{processed:number;failed:number}>{
  let processed=0,failed=0;
  for(let i=0;i<limit;i++){
    const outcome=await ctx.db.invocation(async()=>{
      const job=await ctx.db.transaction(async()=>{
        const row=await ctx.db.one<Job>("SELECT * FROM job_queue WHERE (state='pending' AND available_at<=?) OR (state='processing' AND lease_until<=?) ORDER BY available_at,id LIMIT 1",ctx.now(),ctx.now());
        if(!row)return null;const lease=crypto.randomUUID();
        await ctx.db.run("UPDATE job_queue SET state='processing',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",lease,ctx.now()+180000,row.id);
        return {...row,lease_token:lease};
      });
      if(!job)return null;
      try{
        const payload=JSON.parse(job.payload_json);
        if(job.category==='photo')await processPhotoJob(payload,ctx);
        else if(job.category==='privacy')await processPrivacyJob(payload,ctx);
        else if(job.category==='notification')await processNotificationJob(payload,ctx);
        else throw new ApiError(500,'invalid_job');
        await ctx.db.run("UPDATE job_queue SET state='completed',lease_token=NULL,lease_until=NULL,completed_at=?,error_code=NULL WHERE id=? AND lease_token=?",ctx.now(),job.id,job.lease_token);return 'processed' as const;
      }catch(error){
        const code=error instanceof ApiError?error.code:'job_execution_failed';
        await ctx.db.run("UPDATE job_queue SET state=?,lease_token=NULL,lease_until=NULL,available_at=?,error_code=? WHERE id=? AND lease_token=?",job.attempts>=19?'failed':'pending',ctx.now()+Math.min(3600000,30000*2**Math.min(job.attempts,7)),code,job.id,job.lease_token);return 'failed' as const;
      }
    });
    if(outcome===null)break;
    if(outcome==='processed')processed++;else failed++;
  }
  return {processed,failed};
}

const DAY=86400000;
const healthDeadlines=Object.freeze({active_deletion_target:7*DAY/1000,ordinary_deletion_limit:30*DAY/1000,cleanup_target:DAY/1000,writer_target:DAY/1000});
const backupQualification=Object.freeze({qualification:'UNVERIFIED' as const,target_seconds:14*DAY/1000,provider_measurement_configured:false});
type RetentionSummary={status:'observed';verified:number;pending:number;failed:number}|{status:'unavailable';verified:null;pending:null;failed:null};
type BacklogRow={total:number;failed:number;failed_held:number;held:number;oldest_at:number|null;oldest_unheld_at:number|null;oldest_held_at:number|null;oldest_failed_at:number|null;
  target_overdue:number;target_overdue_held:number;ordinary_overdue:number;ordinary_overdue_held:number};
type Backlog={failed:number;failed_held:number;failed_unheld:number;held:number;unheld:number;oldest_age_seconds:number|null;oldest_unheld_age_seconds:number|null;
  oldest_held_age_seconds:number|null;oldest_failed_age_seconds:number|null;target_overdue:number;target_overdue_held:number;target_overdue_unheld:number;
  ordinary_overdue:number;ordinary_overdue_held:number;ordinary_overdue_unheld:number};
type ObjectBacklog=Omit<Backlog,'ordinary_overdue'|'ordinary_overdue_held'|'ordinary_overdue_unheld'>;
type HoldSummary={global_retention_active:boolean;active_request_holds:number;active_moderation_holds:number;active_asset_holds:number};
type PrivacyHealth={protocol:'lovelies-maintenance-health-v1';status:'observed'|'unavailable';observed_at:string;deadlines_seconds:typeof healthDeadlines;
  holds:HoldSummary|null;deletion_requests:(Backlog&{unfinished:number})|null;cleanup:(ObjectBacklog&{unverified:number})|null;writers:(ObjectBacklog&{unsettled:number})|null;backups:typeof backupQualification};
function count(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ApiError(503,'maintenance_health_unavailable');
  return value;
}
function age(value:unknown,now:number):number|null {
  if(value===null)return null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ApiError(503,'maintenance_health_unavailable');
  return Math.max(0,Math.floor((now-value)/1000));
}
function backlog(row:BacklogRow|null,now:number):Backlog&{total:number} {
  if(!row)throw new ApiError(503,'maintenance_health_unavailable');
  const total=count(row.total),failed=count(row.failed),failed_held=count(row.failed_held),held=count(row.held),target=count(row.target_overdue),target_held=count(row.target_overdue_held),ordinary=count(row.ordinary_overdue),ordinary_held=count(row.ordinary_overdue_held);
  if(held>total||failed>total||failed_held>failed||failed_held>held||failed-failed_held>total-held||target>total||target_held>target||target_held>held||target-target_held>total-held||ordinary>total||ordinary_held>ordinary||ordinary_held>held||ordinary-ordinary_held>total-held||
     (total===0)!==(row.oldest_at===null)||(total===held)!==(row.oldest_unheld_at===null)||(held===0)!==(row.oldest_held_at===null)||(failed===0)!==(row.oldest_failed_at===null))throw new ApiError(503,'maintenance_health_unavailable');
  return {total,failed,failed_held,failed_unheld:failed-failed_held,held,unheld:total-held,oldest_age_seconds:age(row.oldest_at,now),oldest_unheld_age_seconds:age(row.oldest_unheld_at,now),
    oldest_held_age_seconds:age(row.oldest_held_at,now),oldest_failed_age_seconds:age(row.oldest_failed_at,now),target_overdue:target,target_overdue_held:target_held,target_overdue_unheld:target-target_held,
    ordinary_overdue:ordinary,ordinary_overdue_held:ordinary_held,ordinary_overdue_unheld:ordinary-ordinary_held};
}
function objectBacklog(value:Backlog&{total:number}):ObjectBacklog&{total:number} {
  return {total:value.total,failed:value.failed,failed_held:value.failed_held,failed_unheld:value.failed_unheld,held:value.held,unheld:value.unheld,
    oldest_age_seconds:value.oldest_age_seconds,oldest_unheld_age_seconds:value.oldest_unheld_age_seconds,oldest_held_age_seconds:value.oldest_held_age_seconds,
    oldest_failed_age_seconds:value.oldest_failed_age_seconds,target_overdue:value.target_overdue,target_overdue_held:value.target_overdue_held,target_overdue_unheld:value.target_overdue_unheld};
}
const aggregateBacklog=`SELECT count(*) AS total,count(*) FILTER(WHERE failed) AS failed,count(*) FILTER(WHERE failed AND held) AS failed_held,
  count(*) FILTER(WHERE held) AS held,min(created_at) AS oldest_at,min(created_at) FILTER(WHERE NOT held) AS oldest_unheld_at,
  min(created_at) FILTER(WHERE held) AS oldest_held_at,min(created_at) FILTER(WHERE failed) AS oldest_failed_at,
  count(*) FILTER(WHERE created_at<=?) AS target_overdue,count(*) FILTER(WHERE created_at<=? AND held) AS target_overdue_held,
  count(*) FILTER(WHERE created_at<=?) AS ordinary_overdue,count(*) FILTER(WHERE created_at<=? AND held) AS ordinary_overdue_held FROM `;
const subjectHold=(subject:string)=>`EXISTS(SELECT 1 FROM moderation_holds mh WHERE mh.active=1 AND mh.subject_id=${subject})`;
const deletionHold=(subject:string)=>`EXISTS(SELECT 1 FROM privacy_requests hr WHERE hr.subject_id=${subject} AND hr.request_type='delete' AND hr.legal_hold=1 AND hr.status NOT IN('completed','rejected','cancelled'))`;
const heldAsset=`(EXISTS(SELECT 1 FROM asset_retention ar WHERE ar.asset_id=a.id AND ar.legal_hold=1)
  OR EXISTS(SELECT 1 FROM moderation_holds ah WHERE ah.active=1 AND ah.asset_id=a.id))`;
// An asset hold applies only to that asset's exact keys/canonical write prefixes.
// A different held photo belonging to the same account cannot waive an overdue
// object obligation. These are metadata observations, never deletion authority.
const objectHold=(subject:string,key:string,bucket:string)=>`EXISTS(SELECT 1 FROM assets a WHERE a.owner_id=${subject} AND ${heldAsset} AND (
  (${bucket}='QUARANTINE' AND (a.object_key=${key}
    OR EXISTS(SELECT 1 FROM upload_chunks uc WHERE uc.asset_id=a.id AND uc.object_key=${key})
    OR instr(${key},'upload-chunk/'||a.owner_id||'/'||a.id||'/')=1
    OR instr(${key},'source/'||a.owner_id||'/'||a.id||'/'||a.version||'/')=1))
  OR (${bucket}='PHOTOS' AND (EXISTS(SELECT 1 FROM renditions rd WHERE rd.asset_id=a.id AND rd.object_key=${key})
    OR EXISTS(SELECT 1 FROM processing_attempts pa WHERE pa.asset_id=a.id AND pa.rendition_key=${key})
    OR instr(${key},'preview/'||a.owner_id||'/'||a.id||'/')=1))))`;
async function readPrivacyHealth(ctx:AppContext):Promise<PrivacyHealth> {
  const now=ctx.now(),base={protocol:'lovelies-maintenance-health-v1' as const,observed_at:new Date(now).toISOString(),deadlines_seconds:healthDeadlines,backups:backupQualification};
  return ctx.db.transaction(async()=>{
    const holds=await ctx.db.one<HoldSummary>(`SELECT EXISTS(SELECT 1 FROM retention_settings WHERE id='default' AND legal_hold=1) AS global_retention_active,
      (SELECT count(*) FROM privacy_requests WHERE request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled')) AS active_request_holds,
      (SELECT count(*) FROM moderation_holds WHERE active=1) AS active_moderation_holds,(SELECT count(*) FROM asset_retention WHERE legal_hold=1) AS active_asset_holds`);
    if(!holds||typeof holds.global_retention_active!=='boolean')throw new ApiError(503,'maintenance_health_unavailable');
    count(holds.active_request_holds);count(holds.active_moderation_holds);count(holds.active_asset_holds);
    const global=holds.global_retention_active?1:0;
    const deletion=backlog(await ctx.db.one<BacklogRow>(`WITH deletion_backlog AS (
      SELECT r.created_at,r.status='failed' AS failed,(?=1 OR r.legal_hold=1 OR ${subjectHold('r.subject_id')}
        OR EXISTS(SELECT 1 FROM assets a WHERE a.owner_id=r.subject_id AND ${heldAsset})) AS held
      FROM privacy_requests r WHERE r.request_type='delete' AND r.status NOT IN('completed','rejected','cancelled'))
      ${aggregateBacklog}deletion_backlog`,global,now-7*DAY,now-7*DAY,now-30*DAY,now-30*DAY),now);
    const cleanup=backlog(await ctx.db.one<BacklogRow>(`WITH cleanup_backlog AS (
      SELECT c.created_at,c.status='failed' AS failed,(?=1 OR ${subjectHold('c.subject_id')} OR ${deletionHold('c.subject_id')}
        OR EXISTS(SELECT 1 FROM privacy_requests cr WHERE cr.id=c.request_id AND cr.legal_hold=1)
        OR ${objectHold('c.subject_id','c.object_key','c.bucket')}) AS held
      FROM cleanup_intents c WHERE c.status<>'verified'
      UNION ALL
      SELECT o.created_at,(o.status='failed' OR j.status='failed') AS failed,(?=1 OR ${subjectHold('j.subject_id')} OR ${deletionHold('j.subject_id')}
        OR EXISTS(SELECT 1 FROM assets a WHERE a.id=j.asset_id AND ${heldAsset})) AS held
      FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE o.status<>'verified')
      ${aggregateBacklog}cleanup_backlog`,global,global,now-DAY,now-DAY,now-DAY,now-DAY),now);
    const writers=backlog(await ctx.db.one<BacklogRow>(`WITH writer_backlog AS (
      SELECT w.created_at,false AS failed,(?=1 OR ${subjectHold('w.account_id')} OR ${deletionHold('w.account_id')}
        OR ${objectHold('w.account_id','w.object_key','w.bucket')}) AS held
      FROM media_write_intents w WHERE w.status='pending')
      ${aggregateBacklog}writer_backlog`,global,now-DAY,now-DAY,now-DAY,now-DAY),now);
    const {total:unfinished,...deletionStats}=deletion,{total:unverified,...cleanupStats}=objectBacklog(cleanup),{total:unsettled,...writerStats}=objectBacklog(writers);
    return {...base,status:'observed' as const,holds,deletion_requests:{unfinished,...deletionStats},cleanup:{unverified,...cleanupStats},writers:{unsettled,...writerStats}};
  });
}

export async function maintain(ctx:AppContext):Promise<{processed:number;failed:number;maintenance_errors:number;retention:RetentionSummary;privacy_health:PrivacyHealth}>{
  return ctx.db.invocation(async()=>{
    let maintenance_errors=0;
    let retention:RetentionSummary={status:'unavailable',verified:null,pending:null,failed:null};
    for(const task of [maintainAudience,cleanupFaceProofs,flushPhotoOutbox,expireUploads,flushPrivacyCleanup,finishLifecycleCleanup,flushNotificationOutbox,runRetention,pruneRefreshDeliveries]){
      try{
        const result=await ctx.db.invocation<Awaited<ReturnType<typeof task>>>(()=>task(ctx));
        if(task===runRetention){
          const summary=record(result);
          retention={status:'observed',verified:count(summary.verified),pending:count(summary.pending),failed:count(summary.failed)};
          if(retention.failed)maintenance_errors++;
        }
      }catch(error){
        if(error instanceof ApiError&&['restore_reconciliation_required','restore_journal_unavailable'].includes(error.code))throw error;
        maintenance_errors++;
      }
    }
    const jobs=await drainJobs(ctx);
    let privacy_health:PrivacyHealth;
    try{
      privacy_health=await readPrivacyHealth(ctx);
      // Count failing checks, not individual objects. Held obligations and their
      // unchanged clocks stay visible, without being asserted physically erased.
      if(privacy_health.deletion_requests!.failed_unheld||privacy_health.deletion_requests!.ordinary_overdue_unheld)maintenance_errors++;
      if(privacy_health.cleanup!.failed_unheld||privacy_health.cleanup!.target_overdue_unheld)maintenance_errors++;
      if(privacy_health.writers!.target_overdue_unheld)maintenance_errors++;
    }catch{
      maintenance_errors++;
      privacy_health={protocol:'lovelies-maintenance-health-v1',status:'unavailable',observed_at:new Date(ctx.now()).toISOString(),deadlines_seconds:healthDeadlines,
        holds:null,deletion_requests:null,cleanup:null,writers:null,backups:backupQualification};
    }
    return {...jobs,maintenance_errors,retention,privacy_health};
  });
}
