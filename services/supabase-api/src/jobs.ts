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
    const job=await ctx.db.transaction(async()=>{
      const row=await ctx.db.one<Job>("SELECT * FROM job_queue WHERE (state='pending' AND available_at<=?) OR (state='processing' AND lease_until<=?) ORDER BY available_at,id LIMIT 1",ctx.now(),ctx.now());
      if(!row)return null;const lease=crypto.randomUUID();
      await ctx.db.run("UPDATE job_queue SET state='processing',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",lease,ctx.now()+180000,row.id);
      return {...row,lease_token:lease};
    });
    if(!job)break;
    try{
      const payload=JSON.parse(job.payload_json);
      if(job.category==='photo')await processPhotoJob(payload,ctx);
      else if(job.category==='privacy')await processPrivacyJob(payload,ctx);
      else if(job.category==='notification')await processNotificationJob(payload,ctx);
      else throw new ApiError(500,'invalid_job');
      await ctx.db.run("UPDATE job_queue SET state='completed',lease_token=NULL,lease_until=NULL,completed_at=?,error_code=NULL WHERE id=? AND lease_token=?",ctx.now(),job.id,job.lease_token);processed++;
    }catch(error){
      const code=error instanceof ApiError?error.code:'job_execution_failed';
      await ctx.db.run("UPDATE job_queue SET state=?,lease_token=NULL,lease_until=NULL,available_at=?,error_code=? WHERE id=? AND lease_token=?",job.attempts>=19?'failed':'pending',ctx.now()+Math.min(3600000,30000*2**Math.min(job.attempts,7)),code,job.id,job.lease_token);failed++;
    }
  }
  return {processed,failed};
}

export async function maintain(ctx:AppContext):Promise<{processed:number;failed:number;maintenance_errors:number}>{
  let maintenance_errors=0;
  for(const task of [cleanupFaceProofs,flushPhotoOutbox,expireUploads,flushPrivacyCleanup,finishLifecycleCleanup,flushNotificationOutbox,runRetention,pruneRefreshDeliveries]){
    try{await task(ctx);}catch{maintenance_errors++;}
  }
  return {...await drainJobs(ctx),maintenance_errors};
}
