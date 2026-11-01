/** Trusted, resumable recovery controller. Public serving stays quarantined
 * until SQL replay, retired authority and independent Storage inventory agree.
 * No business callback is rerun; unresolved remote writers remain explicit. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {maintainManagedAuth} from './managed-auth.ts';
import {retirePushSubject,type PushSubjectRetirementProof} from './push-roster.ts';
import {ApiError,digest,stable,type AppContext,type Binding,type Database,type PrivateBucket,type SupabaseEnv} from './types.ts';
import {postgresQuery,type SqlConnection} from './database.ts';
import {RESTORE_PROJECT_ID,RESTORE_JOURNAL_PROTOCOL,validateRestoreControl,validateRestoreMarker,type RestoreJournalClient,type RestoreMarker} from './restore-journal.ts';
import {applyRestrictionReceipt} from './restore-replay.ts';
import {validateEffectRecord,type EffectRecord} from './restore-effects.ts';
import {readPrivateBytes} from './private-body.ts';
import {RestoreTransactionCollector,type RestoreTransactionScope} from './restore-transaction.ts';
import {replayErasedAccountForRestore,completeErasedAccountForRestore} from './privacy.ts';
const ZERO='0'.repeat(64),buckets=['PHOTOS','QUARANTINE','PRIVACY_EXPORTS'] as const;
const bad=(code='restore_recovery_unconfirmed'):never=>{throw new ApiError(503,code);};
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
export interface RecoveryBucket extends PrivateBucket{list(prefix:string,offset?:number,limit?:number):Promise<readonly {name:string;folder:boolean}[]>;}
type RecoveryView={control:ReturnType<typeof validateRestoreControl>;recovery:{version:2;project_id:string;recovery_id:string;generation:number;prior_marker:RestoreMarker;prior_pending_operation_id:string|null;incarnation_id:string;journal_head:RestoreMarker['cursor'];effect_head:RestoreMarker['cursor'];reason:string;created_at:number;generation_hash:string};progress:{replayed:RestoreMarker['cursor'];effect_sequence:number;effect_hash:string;observation_head:RestoreMarker['cursor'];retirement_hash:string|null;phase:'replaying'|'prepared'|'completed';clearance:any}};
class RecoveryDatabase implements Database{
 constructor(private readonly connection:SqlConnection){}
 inTransaction():boolean{return true;}
 async invocation<T>(callback:()=>T|Promise<T>):Promise<T>{return callback();}
 bindInvocationAuthority():never{return bad('restore_product_authority_denied');}
 async all<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T[]>{const query=postgresQuery(sql,bindings);return this.connection.query<T>(query.sql,query.values);}
 async one<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T|null>{const rows=await this.all<T>(sql,...bindings);if(rows.length>1)return bad();return rows[0]??null;}
 async run(sql:string,...bindings:Binding[]):Promise<void>{await this.all(sql,...bindings);}
 async read<T>(callback:()=>T|Promise<T>):Promise<T>{return callback();}
 async transaction<T>(callback:(scope:RestoreTransactionScope)=>T|Promise<T>):Promise<T>{const collector=new RestoreTransactionCollector();try{return await callback(collector.scope) as T;}finally{collector.close();}}
}
/** One context spans external cleanup and metadata replay, but each SQL phase
 * re-enters the independent generation guard. Async-local binding keeps nested
 * domain transactions on that same guarded connection. Provider calls see no
 * active transaction, including when two recovery controllers run concurrently. */
class RecoveryPhaseDatabase implements Database{
 private readonly active=new AsyncLocalStorage<RecoveryDatabase>();
 private readonly connections=new AsyncLocalStorage<SqlConnection>();
 constructor(private readonly guarded:<T>(callback:(connection:SqlConnection)=>Promise<T>)=>Promise<T>){}
 inTransaction():boolean{return this.active.getStore()!==undefined;}
 connection():SqlConnection{const current=this.connections.getStore();if(!current)return bad('restore_phase_transaction_required');return current;}
 async invocation<T>(callback:()=>T|Promise<T>):Promise<T>{return callback();}
 bindInvocationAuthority():never{return bad('restore_product_authority_denied');}
 async all<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T[]>{
  const current=this.active.getStore();return current?current.all<T>(sql,...bindings):this.transaction(()=>this.all<T>(sql,...bindings));
 }
 async one<T=Record<string,unknown>>(sql:string,...bindings:Binding[]):Promise<T|null>{const rows=await this.all<T>(sql,...bindings);if(rows.length>1)return bad();return rows[0]??null;}
 async run(sql:string,...bindings:Binding[]):Promise<void>{await this.all(sql,...bindings);}
 async read<T>(callback:()=>T|Promise<T>):Promise<T>{return this.transaction(callback);}
 async transaction<T>(callback:(scope:RestoreTransactionScope)=>T|Promise<T>):Promise<T>{
  const current=this.active.getStore();if(current)return current.transaction(callback);
  return this.guarded(connection=>this.connections.run(connection,()=>this.active.run(new RecoveryDatabase(connection),()=>this.transaction<T>(callback))));
 }
}
type RecoveryServices=Partial<Pick<SupabaseEnv,'MANAGED_AUTH'|'MANAGED_AUTH_ENCRYPTION_KEY'|'AUTH_SIGNING_SECRET'|'MEDIA_SIGNING_SECRET'|
 'PUSH_SERVICE'|'PUSH_PROVIDER_GENERATION'|'PUSH_LEDGER_ID'|'PUSH_LEDGER_BOOTSTRAP_ID'>> & {testOnlyLegacy?:true};
export class RestoreRecoveryController{
 constructor(private readonly connection:SqlConnection,private readonly journal:RestoreJournalClient,
  private readonly storage:Record<typeof buckets[number],RecoveryBucket>,private readonly now:()=>number=Date.now,private readonly services:RecoveryServices={}){}
 private async request(path:string,body?:unknown):Promise<RecoveryView>{
  const raw=await this.journal.request(path,body,(value,status)=>({value,status}));
  if(raw.status!==200){if(object(raw.value)&&typeof raw.value.error==='string'&&/^[a-z_]{1,80}$/.test(raw.value.error))throw new ApiError(raw.status,raw.value.error);return bad();}
  const v=raw.value;if(!object(v)||v.protocol!==RESTORE_JOURNAL_PROTOCOL||v.project_id!==RESTORE_PROJECT_ID||!object(v.recovery)||!object(v.progress))return bad();
  const control=validateRestoreControl(v.control),r=v.recovery,p=v.progress;
  if(r.version!==2||r.project_id!==RESTORE_PROJECT_ID||!uuid(r.recovery_id)||!uuid(r.incarnation_id)||!hash(r.generation_hash)||!Number.isSafeInteger(r.generation)||r.generation<1||
   r.generation_hash!==await digest(stable(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='generation_hash'))))||
   !['replaying','prepared','completed'].includes(p.phase)||!Number.isSafeInteger(p.effect_sequence)||p.effect_sequence<0||!hash(p.effect_hash))return bad();
  validateRestoreMarker(r.prior_marker);for(const cursor of [r.journal_head,r.effect_head,p.replayed,p.observation_head])if(!object(cursor)||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||!hash(cursor.hash)||cursor.sequence===0&&cursor.hash!==ZERO)return bad();
  if(p.clearance){const c=p.clearance;if(!object(c)||!hash(c.clearance_hash)||c.generation_hash!==r.generation_hash||c.recovery_id!==r.recovery_id||
    c.clearance_hash!==await digest(stable(Object.fromEntries(Object.entries(c).filter(([k])=>!['clearance_hash','marker','prepared_at'].includes(k)))))||
    validateRestoreMarker(c.marker).checkpoint.hash!==c.clearance_hash)return bad();}
  return {control,recovery:r,progress:p} as RecoveryView;
 }
 private body(view:RecoveryView,fields:Record<string,unknown>={}):Record<string,unknown>{return {version:2,project_id:RESTORE_PROJECT_ID,generation_hash:view.recovery.generation_hash,...fields};}
 private async guarded<T>(view:RecoveryView,callback:(connection:SqlConnection)=>Promise<T>):Promise<T>{
  return this.connection.begin(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);await c.query('SET LOCAL ROLE lovelies_api',[]);
   await c.query('SET LOCAL search_path TO lovelies_private,pg_catalog',[]);await c.query("SELECT set_config('lovelies.restore_replay','on',true)",[]);
   const current=await this.read(view.recovery.recovery_id);
   if(current.recovery.generation_hash!==view.recovery.generation_hash||current.progress.phase==='completed'||current.control.state!=='quarantined'||current.control.recovery_generation_id!==view.recovery.recovery_id)return bad('restore_generation_retired');
   const rows=await c.query<any>('SELECT * FROM restore_control WHERE singleton=1',[]);if(rows.length!==1||rows[0].database_id!==view.recovery.prior_marker.database_id||
    Number(rows[0].checkpoint_revision)>view.recovery.prior_marker.checkpoint.revision&&!(rows[0].incarnation_id===view.recovery.incarnation_id&&rows[0].last_operation_id===view.recovery.recovery_id))return bad('restore_database_identity_changed');
   return callback(c);
  });
 }
 async read(id:string):Promise<RecoveryView>{if(!uuid(id))return bad('restore_recovery_id_invalid');return this.request('/v1/recovery/'+id);}
 async begin(id:string):Promise<RecoveryView>{
  if(!uuid(id))return bad('restore_recovery_id_invalid');let view:RecoveryView|undefined;
  try{view=await this.read(id);}catch(error){if(!(error instanceof ApiError)||error.status!==404)throw error;}
  if(!view){
   const control=await this.journal.control();
   if(control.pending_operation_id){const operation=await this.journal.lookup(control.pending_operation_id);if(operation?.status==='preparing')await this.journal.finishPreparation(operation);}
   view=await this.request('/v1/recovery/begin-v2',{version:2,project_id:RESTORE_PROJECT_ID,recovery_id:id,expected:control.marker});
  }
  if(view.progress.phase==='completed')return view;
  const selected=view;
  await this.guarded(selected,async c=>{
   const existing=await c.query<any>('SELECT * FROM restore_recovery_runs WHERE id=$1',[id]);
   if(existing.length&&(existing[0].generation_hash!==selected.recovery.generation_hash||existing[0].database_id!==selected.recovery.prior_marker.database_id||existing[0].incarnation_id!==selected.recovery.incarnation_id))return bad('restore_generation_retired');
   await c.query("INSERT INTO restore_recovery_runs(id,database_id,prior_incarnation_id,incarnation_id,generation_hash,restriction_sequence,restriction_hash,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'replaying',$8,$8) ON CONFLICT(id) DO NOTHING",[id,selected.recovery.prior_marker.database_id,selected.recovery.prior_marker.incarnation_id,selected.recovery.incarnation_id,selected.recovery.generation_hash,selected.recovery.journal_head.sequence,selected.recovery.journal_head.hash,selected.recovery.created_at]);
  });return selected;
 }
 private async retireAuthority(c:SqlConnection,view:RecoveryView):Promise<void>{
  const row=(await c.query<any>('SELECT retired_at FROM restore_recovery_runs WHERE id=$1',[view.recovery.recovery_id]))[0];if(!row)return bad();if(row.retired_at!==null)return;
  const at=this.now(),q=(sql:string,args:unknown[]=[])=>c.query(sql,args);
  // An old backup's role is not proof of a current independently provisioned
  // operator. Preserve ordinary account roles; only admin authority is retired.
  await q("UPDATE accounts SET roles_json=coalesce((SELECT jsonb_agg(value)::text FROM jsonb_array_elements(roles_json::jsonb) role(value) WHERE value<>'\"admin\"'::jsonb),'[]') WHERE roles_json::jsonb ? 'admin'");
  await q('UPDATE sessions SET revoked_at=coalesce(revoked_at,$1),refresh_consumed_at=coalesce(refresh_consumed_at,$1)',[at]);
  await q("UPDATE refresh_delivery_receipts SET state='cancelled',ciphertext=NULL,iv=NULL");
  // Keep encrypted cleanup custody until public Auth APIs verify retirement;
  // no restored managed binding remains usable during or after this phase.
  await q("UPDATE managed_auth_bindings SET state='retiring',updated_at=$1 WHERE user_deleted_at IS NULL",[at]);
  await q("UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,$1) WHERE used_at IS NULL",[at]);
  await q('UPDATE face_enrollment_intents SET revoked_at=coalesce(revoked_at,$1)',[at]);await q('UPDATE face_recovery_keys SET revoked_at=coalesce(revoked_at,$1)',[at]);
  await q('DELETE FROM face_profile_controls');await q("UPDATE face_profile_operations SET state='cancelled' WHERE state='pending'");
  await q("UPDATE auth_devices SET status='revoked',face_handle=NULL WHERE status IN('pending','active')");
  await q("UPDATE consents SET status='revoked',revoked_at=coalesce(revoked_at,$1) WHERE status='granted'",[at]);
  await q("UPDATE guardian_purpose_approvals SET status='revoked',revoked_at=coalesce(revoked_at,$1) WHERE status<>'revoked'",[at]);
  await q("UPDATE guardian_requests SET state='withdrawn',revision=revision+1,terminated_at=coalesce(terminated_at,$1) WHERE state IN('pending','under_review','approved')",[at]);
  await q("UPDATE face_profiles SET status='revoked',auth_enabled=0");
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE active=1',[at]);
  await q("UPDATE sharing_requests SET status='revoked',updated_at=$1 WHERE status IN('requested','accepted')",[at]);
  await q('DELETE FROM media_tickets');await q('DELETE FROM download_tickets');await q('UPDATE privacy_export_grants SET consumed_at=coalesce(consumed_at,$1)',[at]);
  await q("UPDATE privacy_exports SET status='retired'");await q('UPDATE privacy_requests SET export_expires_at=$1 WHERE export_expires_at IS NOT NULL AND export_expires_at>$1',[at]);
  await q('UPDATE store_subscriptions SET active=0,version=version+1 WHERE active=1');
  await q('UPDATE push_devices SET active=0');
  const capabilityTable=await q("SELECT to_regclass('lovelies_private.operator_capability_grants')::text AS present") as {present:string|null}[];
  if(capabilityTable[0]?.present){await q('UPDATE operator_capability_grants SET revoked_at=coalesce(revoked_at,$1)',[at]);await q('UPDATE operator_access_versions SET version=version+1');}

  await q("UPDATE notification_deliveries SET status='cancelled',updated_at=$1 WHERE status='queued' AND attempts=0 AND lease_token IS NULL AND provider_receipt IS NULL",[at]);
  await q("UPDATE notification_jobs SET status='ambiguous' WHERE status IN('queued','dispatched') AND EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.notification_id=notification_jobs.notification_id AND(d.attempts>0 OR d.status IN('dispatching','ambiguous','accepted')))");
  await q("UPDATE notification_jobs SET status='cancelled' WHERE status IN('queued','dispatched')");
  await q("UPDATE processing_attempts SET status='failed',error_code='restore_generation_retired',lease_token=NULL,lease_until=NULL WHERE status NOT IN('completed','failed','cancelled')");
  await q("UPDATE candidates SET status='invalidated' WHERE status IN('eligible','needs_review')");
  await q("UPDATE job_queue SET state='failed',error_code='restore_generation_retired',lease_token=NULL,lease_until=NULL WHERE state IN('pending','processing')");
  await q("UPDATE privacy_requests SET status='failed',failure_code='restore_authority_retired',execution_token=NULL,lease_until=NULL WHERE status IN('approved','queued','processing')");
  await q("UPDATE photo_job_outbox SET status='failed' WHERE status NOT IN('completed','failed')");
  await q("UPDATE upload_transfers SET state='cancelled' WHERE state='uploading'");
  await q("UPDATE restore_recovery_runs SET retired_at=$1,state='cleanup',updated_at=$1 WHERE id=$2",[at,view.recovery.recovery_id]);
 }
 private recoveryContext(view:RecoveryView):AppContext{
  const db=new RecoveryPhaseDatabase(callback=>this.guarded(view,callback)),env:SupabaseEnv={...this.services,
   APP_ENV:this.services.testOnlyLegacy?'test':'recovery',...this.storage,PHOTO_JOBS:{send:async()=>bad('restore_job_dispatch_denied')}};
  return {db,env,now:this.now,authenticate:async()=>bad('restore_product_authority_denied'),assertActor:async()=>bad('restore_product_authority_denied')};
 }
 private async assertIndependentErasureHolds(c:SqlConnection,view:RecoveryView,subject:string):Promise<void>{
  const rows=await c.query<{n:number}>(`SELECT count(*) n FROM restore_replay_facts f WHERE f.sequence<=$2 AND
   ((f.kind='account-moderation-restricted' AND f.scope_json::jsonb->>'account_id'=$1 OR f.kind='asset-moderation-restricted' AND f.scope_json::jsonb->>'owner_id'=$1)
      AND NOT EXISTS(SELECT 1 FROM restore_replay_facts e WHERE e.kind='moderation-restriction-ended' AND e.sequence>f.sequence AND e.sequence<=$2
        AND e.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id')
    OR (f.kind='global-retention-hold-started' OR f.kind='asset-retention-hold-started' AND f.scope_json::jsonb->>'owner_id'=$1 OR f.kind='privacy-hold-started' AND f.scope_json::jsonb->>'account_id'=$1)
      AND NOT EXISTS(SELECT 1 FROM restore_replay_facts e WHERE e.kind=replace(f.kind,'-started','-ended') AND e.sequence>f.sequence AND e.sequence<=$2
        AND e.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id'))`,[subject,view.recovery.journal_head.sequence]);
  if(Number(rows[0]?.n))return bad('restore_cleanup_held');
 }
 private async erasureStep(ctx:AppContext,view:RecoveryView,complete=false):Promise<boolean>{
  const db=ctx.db as RecoveryPhaseDatabase,cursorKey=complete?'erasure_completion_sequence':'metadata_erasure_sequence',
   doneKey=complete?'erasure_completed':'metadata_erasure_replayed';
  const select=async()=>{
   const run=await db.one<any>('SELECT state,clearance_json FROM restore_recovery_runs WHERE id=?',view.recovery.recovery_id);if(!run)return bad();
   const state=run.clearance_json?JSON.parse(run.clearance_json):{generation_hash:view.recovery.generation_hash};
   if(state.generation_hash!==view.recovery.generation_hash)return bad('restore_generation_retired');
   if(run.state==='prepared'||run.state==='complete'||state[doneKey]===true)return {done:true,state,row:null,scope:null,proof:null};
   const cursor=state[cursorKey]??0;if(!Number.isSafeInteger(cursor)||cursor<0)return bad();
   const row=await db.one<{sequence:number;scope_json:string}>("SELECT sequence,scope_json FROM restore_replay_facts WHERE kind='account-erased' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 1",cursor,view.recovery.journal_head.sequence);
   if(!row)return {done:false,state,row:null,scope:null,proof:null};
   const scope=JSON.parse(row.scope_json);
   const review=await db.one<{scope_json:string}>("SELECT scope_json FROM restore_replay_facts WHERE kind='account-deletion-reviewed' AND sequence<=? AND scope_json::jsonb->>'account_id'=? AND scope_json::jsonb->>'deletion_request_id'=? AND scope_json::jsonb->>'decision'='approved' ORDER BY sequence DESC LIMIT 1",view.recovery.journal_head.sequence,scope.account_id,scope.deletion_request_id);
   const matched=review&&JSON.parse(review.scope_json);if(!matched)return bad('restore_erasure_approval_missing');
   const request=await db.one<any>('SELECT reviewed_at,reviewed_by,subject_id FROM privacy_requests WHERE id=?',scope.deletion_request_id);
   if(!request){if(await db.one('SELECT id FROM accounts WHERE id=?',scope.account_id))return bad('restore_erasure_binding_unverified');
    return {done:false,state,row,scope,proof:null};}
   if(request.subject_id!==scope.account_id||request.reviewed_by!==matched.reviewer_id)return bad('restore_erasure_binding_unverified');
   await this.assertIndependentErasureHolds(db.connection(),view,scope.account_id);
   return {done:false,state,row,scope,proof:{recovery_id:view.recovery.recovery_id,reviewer_id:matched.reviewer_id,reviewed_at:Number(request.reviewed_at)}};
  };
  const selected=await db.read(select);if(selected.done)return true;
  // Exact independent erasure/approval/hold checks above precede any permanent
  // push retirement. The same checks repeat after the external reply. The proof
  // is bound in memory to this context/database; serialized input cannot forge it.
  let pushProof:PushSubjectRetirementProof|null=null;
  if(!complete&&selected.proof)pushProof=await retirePushSubject(ctx,selected.scope.account_id);
  return db.transaction(async()=>{
   const current=await select();if(current.done)return true;
   if(current.row?.sequence!==selected.row?.sequence||current.row?.scope_json!==selected.row?.scope_json||!equal(current.proof,selected.proof))return false;
   if(current.row){
    if(current.proof){
     if(complete)await completeErasedAccountForRestore(ctx,current.scope.account_id,current.scope.deletion_request_id,current.proof);
     else await replayErasedAccountForRestore(ctx,current.scope.account_id,current.scope.deletion_request_id,current.proof,pushProof);
    }
    current.state[cursorKey]=Number(current.row.sequence);
   }else current.state[doneKey]=true;
   await db.run('UPDATE restore_recovery_runs SET clearance_json=?,updated_at=? WHERE id=?',stable(current.state),this.now(),view.recovery.recovery_id);
   return !current.row;
  });
 }
 private async effectPage(after:number):Promise<{effects:EffectRecord[];head:any}>{
  return this.journal.request('/v1/effects/page',{version:1,project_id:RESTORE_PROJECT_ID,after,limit:32},async(raw,status)=>{
   if(status!==200||!object(raw)||raw.protocol!==RESTORE_JOURNAL_PROTOCOL||raw.project_id!==RESTORE_PROJECT_ID||!Array.isArray(raw.effects)||raw.effects.length>32||!object(raw.head))return bad();
   validateRestoreControl(raw.control);const h=raw.head;
   if(!Number.isSafeInteger(h.sequence)||h.sequence<after||!hash(h.hash)||!Number.isSafeInteger(h.observation_sequence)||h.observation_sequence<0||!hash(h.observation_hash)||h.sequence===0&&h.hash!==ZERO||h.observation_sequence===0&&h.observation_hash!==ZERO)return bad();
   const effects=[];for(const item of raw.effects)effects.push(await validateEffectRecord(item));
   if(effects.some((item,index)=>item.registration.sequence!==after+index+1))return bad();return {effects,head:raw.head};
  });
 }
 private async references(c:SqlConnection,bucket:typeof buckets[number],key:string):Promise<unknown[]>{
  if(bucket!=='PHOTOS')return [];
  return c.query(`SELECT 'asset' AS kind,a.id,a.version,a.owner_id,a.checksum_sha256 AS sha256,a.byte_size AS bytes FROM assets a JOIN accounts u ON u.id=a.owner_id
    WHERE a.object_key=$1 AND a.deleted_at IS NULL AND a.status='ready' AND u.disabled_at IS NULL
    UNION ALL SELECT 'rendition' AS kind,r.id,r.version,a.owner_id,r.checksum_sha256 AS sha256,r.byte_size AS bytes FROM renditions r JOIN assets a ON a.id=r.asset_id JOIN accounts u ON u.id=a.owner_id
    WHERE r.object_key=$1 AND r.status='ready' AND a.deleted_at IS NULL AND u.disabled_at IS NULL ORDER BY kind,id`,[key]);
 }
 private async bytes(bucket:PrivateBucket,key:string,maximum=20*1024*1024):Promise<{hash:string;bytes:number;etag:string}|null>{
  const object=await bucket.get(key);if(!object)return null;if(!Number.isSafeInteger(object.size)||object.size<1||object.size>maximum)return bad('restore_object_size_unverified');
  const data=await readPrivateBytes(object.body,object.size,maximum);try{return {hash:await digest(data),bytes:data.byteLength,etag:object.etag};}finally{data.fill(0);}
 }
 private async reconcileEffect(view:RecoveryView,effect:EffectRecord):Promise<RecoveryView>{
  const d=effect.descriptor,id=view.recovery.recovery_id;
  let proof:Record<string,unknown>={outcome:'historical-only',sha256:null,byte_size:null,etag:null,reference_hash:null,verified_at:this.now()};
  if(d.kind==='storage-put'){
   const name=d.target.bucket as typeof buckets[number];if(!buckets.includes(name))return bad();const bucket=this.storage[name];
   proof=await this.guarded(view,async c=>{
    await c.query("INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,updated_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT(recovery_id,effect_id) DO NOTHING",[id,d.effect_id,name,d.target.object_key,d.payload_hash,d.byte_size,this.now()]);
    const actual=await this.bytes(bucket,d.target.object_key,Math.max(d.byte_size,1));
    if(actual&&(actual.hash!==d.payload_hash||actual.bytes!==d.byte_size))return bad('restore_object_replaced');
    if(['dispatching','unknown'].includes(effect.status)){
     if(!actual)return bad('restore_writer_unresolved');
     const updated=await this.journal.request('/v1/effects/'+d.effect_id+'/observe',{version:1,project_id:RESTORE_PROJECT_ID,descriptor_hash:effect.descriptor_hash,status:'materialized',result:{http_status:null,sha256:actual.hash,byte_size:actual.bytes,etag:actual.etag}},async(raw,status)=>{
       if(status!==200||!object(raw))return bad();return validateEffectRecord(raw.effect);
     });effect=updated;
     // The changed independent observation invalidates the old complete cut.
     throw new ApiError(409,'recovery_effect_cut_changed');
    }
    if(!['registered','succeeded','rejected','cancelled','materialized'].includes(effect.status))return bad('restore_writer_unresolved');
    const refs=await this.references(c,name,d.target.object_key);let result:Record<string,unknown>;
    if(actual&&refs.length){
     if(refs.some((r:any)=>r.sha256!==actual.hash||Number(r.bytes)!==actual.bytes))return bad('restore_reference_changed');
     result={outcome:'preserved',sha256:actual.hash,byte_size:actual.bytes,etag:actual.etag,reference_hash:await digest(stable(refs)),verified_at:this.now()};
    }else{
     if(actual){
      const holds=await c.query<{n:number}>(`SELECT count(*) AS n FROM moderation_holds h WHERE h.active=1 AND (h.asset_id IN(SELECT id FROM assets WHERE object_key=$1) OR h.subject_id IN(SELECT owner_id FROM assets WHERE object_key=$1))`,[d.target.object_key]);
      const legal=await c.query<{n:number}>('SELECT count(*) AS n FROM asset_retention r JOIN assets a ON a.id=r.asset_id WHERE a.object_key=$1 AND r.legal_hold=1',[d.target.object_key]);
      const globalHold=await c.query<{n:number}>('SELECT count(*) n FROM retention_settings WHERE legal_hold=1',[]);
      const subjectHolds=await c.query<{n:number}>(`SELECT (SELECT count(*) FROM privacy_requests p WHERE p.subject_id=$1 AND p.legal_hold=1)
        +(SELECT count(*) FROM moderation_holds h WHERE h.subject_id=$1 AND h.active=1)
        +(SELECT count(*) FROM restore_replay_facts f WHERE (f.kind='account-moderation-restricted' AND f.scope_json::jsonb->>'account_id'=$1
          OR f.kind='asset-moderation-restricted' AND f.scope_json::jsonb->>'owner_id'=$1)
          AND NOT EXISTS(SELECT 1 FROM restore_replay_facts ended WHERE ended.kind='moderation-restriction-ended'
            AND ended.sequence>f.sequence AND ended.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id')) AS n`,[d.target.owner_id]);
      const journalHolds=await c.query<{n:number}>(`SELECT count(*) n FROM restore_replay_facts f
        WHERE (f.kind='global-retention-hold-started' OR f.kind='asset-retention-hold-started' AND f.scope_json::jsonb->>'owner_id'=$1
          OR f.kind='privacy-hold-started' AND f.scope_json::jsonb->>'account_id'=$1)
        AND NOT EXISTS(SELECT 1 FROM restore_replay_facts e WHERE e.kind=replace(f.kind,'-started','-ended') AND e.sequence>f.sequence
          AND e.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id')`,[d.target.owner_id]);
      if(Number(holds[0]?.n)||Number(legal[0]?.n)||Number(globalHold[0]?.n)||Number(subjectHolds[0]?.n)||Number(journalHolds[0]?.n))return bad('restore_cleanup_held');
      const fresh=await bucket.head(d.target.object_key);if(!fresh||fresh.etag!==actual.etag||fresh.size!==actual.bytes)return bad('restore_object_changed');
      if(!equal(await this.references(c,name,d.target.object_key),refs))return bad('restore_reference_changed');
      await bucket.delete(d.target.object_key);if(await bucket.head(d.target.object_key)!==null)return bad('restore_object_not_absent');
     }
     result={outcome:'absent',sha256:null,byte_size:null,etag:null,reference_hash:null,verified_at:this.now()};
    }
    const current=await this.read(id);if(current.recovery.generation_hash!==view.recovery.generation_hash||current.control.state!=='quarantined')return bad('restore_generation_retired');
    await c.query('UPDATE restore_cleanup_objects SET status=$1,proof_json=$2,updated_at=$3 WHERE recovery_id=$4 AND effect_id=$5',[result.outcome,stable(result),this.now(),id,d.effect_id]);
    await c.query("UPDATE media_write_intents SET status='settled',settled_at=coalesce(settled_at,$1) WHERE bucket=$2 AND object_key=$3",[this.now(),name,d.target.object_key]);
    if(result.outcome==='absent')await c.query("UPDATE cleanup_intents SET status='verified',verified_at=$1 WHERE bucket=$2 AND object_key=$3",[this.now(),name,d.target.object_key]);
    return result;
   });
  }
  return this.request('/v1/recovery/'+id+'/effect',this.body(view,{sequence:effect.registration.sequence,descriptor_hash:effect.descriptor_hash,observation_hash:effect.observation?.hash??null,proof}));
 }
 private async inventoryStep(view:RecoveryView):Promise<boolean>{
  return this.guarded(view,async c=>{
   const id=view.recovery.recovery_id;
   for(const name of buckets){const scan='scan:'+name+':root';await c.query("INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json,updated_at) VALUES($1,$2,$3,'',$4,0,'pending',$5,$6) ON CONFLICT(recovery_id,effect_id) DO NOTHING",[id,scan,name,ZERO,stable({kind:'storage-scan',prefix:'',offset:0,root:ZERO}),this.now()]);}
   const rows=await c.query<any>("SELECT * FROM restore_cleanup_objects WHERE recovery_id=$1 AND effect_id LIKE 'scan:%' AND status='pending' ORDER BY effect_id LIMIT 1",[id]);
   if(!rows.length)return true;const row=rows[0],scan=JSON.parse(row.proof_json),name=row.bucket as typeof buckets[number],bucket=this.storage[name];
   if(typeof bucket.list!=='function'||scan.kind!=='storage-scan'||!Number.isSafeInteger(scan.offset)||scan.offset<0||!hash(scan.root))return bad('restore_storage_inventory_unavailable');
   const entries=await bucket.list(scan.prefix,scan.offset,32);if(!Array.isArray(entries)||entries.length>32)return bad('restore_storage_inventory_invalid');
   let root=scan.root;
   for(const entry of entries){const key=scan.prefix+entry.name;root=await digest(stable({previous:root,key,folder:entry.folder}));
    if(entry.folder){const child='scan:'+name+':'+await digest(key+'/');await c.query("INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json,updated_at) VALUES($1,$2,$3,$4,$5,0,'pending',$6,$7) ON CONFLICT(recovery_id,effect_id) DO NOTHING",[id,child,name,key+'/',ZERO,stable({kind:'storage-scan',prefix:key+'/',offset:0,root:ZERO}),this.now()]);continue;}
    const known=await c.query<any>("SELECT * FROM restore_cleanup_objects WHERE recovery_id=$1 AND bucket=$2 AND object_key=$3 AND effect_id NOT LIKE 'scan:%'",[id,name,key]);
    if(known.length){if(known.some(r=>r.status!=='preserved'))return bad('restore_inventory_changed');continue;}
    const refs=await this.references(c,name,key);if(!refs.length)return bad('restore_unknown_object_preserved');
    const actual=await this.bytes(bucket,key);if(!actual||refs.some((r:any)=>r.sha256!==actual.hash||Number(r.bytes)!==actual.bytes))return bad('restore_object_unverified');
    const proof={kind:'existing-reference',outcome:'preserved',sha256:actual.hash,byte_size:actual.bytes,etag:actual.etag,reference_hash:await digest(stable(refs)),verified_at:this.now()};
    await c.query("INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json,updated_at) VALUES($1,$2,$3,$4,$5,$6,'preserved',$7,$8) ON CONFLICT(recovery_id,effect_id) DO NOTHING",[id,'legacy:'+await digest(name+':'+key),name,key,actual.hash,actual.bytes,stable(proof),this.now()]);
   }
   const next={...scan,offset:scan.offset+entries.length,root};await c.query('UPDATE restore_cleanup_objects SET status=$1,expected_sha256=$2,expected_bytes=$3,proof_json=$4,updated_at=$5 WHERE recovery_id=$6 AND effect_id=$7',[entries.length<32?'preserved':'pending',root,next.offset,stable(next),this.now(),id,row.effect_id]);
   return false;
  });
 }
 private async clearanceHash(view:RecoveryView):Promise<string>{
  return this.guarded(view,async c=>{
   const id=view.recovery.recovery_id,row=(await c.query<any>('SELECT * FROM restore_recovery_runs WHERE id=$1',[id]))[0];if(!row||row.retired_at===null)return bad();
   // Independent holds also have to survive into ordinary post-recovery SQL
   // authorization. A missing policy/request/asset row is not permission to
   // reopen and let a later janitor manufacture an unheld default policy.
   const unresolvedHolds=await c.query<{n:number}>(`SELECT count(*) n FROM restore_replay_facts f WHERE f.sequence<=$1 AND
    ((f.kind IN('account-moderation-restricted','asset-moderation-restricted')
       AND NOT EXISTS(SELECT 1 FROM restore_replay_facts e WHERE e.kind='moderation-restriction-ended' AND e.sequence>f.sequence AND e.sequence<=$1 AND e.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id')
       AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.id=f.scope_json::jsonb->>'hold_id' AND h.active=1
          AND (f.kind='account-moderation-restricted' AND h.subject_id=f.scope_json::jsonb->>'account_id'
            OR f.kind='asset-moderation-restricted' AND h.asset_id=f.scope_json::jsonb->>'asset_id')))
     OR (f.kind IN('global-retention-hold-started','asset-retention-hold-started','privacy-hold-started')
       AND NOT EXISTS(SELECT 1 FROM restore_replay_facts e WHERE e.kind=replace(f.kind,'-started','-ended') AND e.sequence>f.sequence AND e.sequence<=$1 AND e.scope_json::jsonb->>'hold_id'=f.scope_json::jsonb->>'hold_id')
       AND NOT (f.kind='global-retention-hold-started' AND EXISTS(SELECT 1 FROM retention_settings p WHERE p.legal_hold=1 AND p.restore_hold_episode_id=f.scope_json::jsonb->>'hold_id')
          OR f.kind='asset-retention-hold-started' AND EXISTS(SELECT 1 FROM asset_retention p JOIN assets a ON a.id=p.asset_id WHERE p.legal_hold=1 AND p.asset_id=f.scope_json::jsonb->>'asset_id' AND a.owner_id=f.scope_json::jsonb->>'owner_id' AND p.restore_hold_episode_id=f.scope_json::jsonb->>'hold_id')
          OR f.kind='privacy-hold-started' AND EXISTS(SELECT 1 FROM privacy_requests p WHERE p.legal_hold=1 AND p.id=f.scope_json::jsonb->>'request_id' AND p.subject_id=f.scope_json::jsonb->>'account_id' AND p.restore_hold_episode_id=f.scope_json::jsonb->>'hold_id'))))`,[view.recovery.journal_head.sequence]);
   if(Number(unresolvedHolds[0]?.n))return bad('restore_hold_metadata_unresolved');
   const checks=["SELECT count(*) n FROM managed_auth_bindings WHERE user_deleted_at IS NULL OR state<>'retired' OR ciphertext IS NOT NULL OR iv IS NOT NULL","SELECT count(*) n FROM accounts WHERE roles_json::jsonb ? 'admin'","SELECT count(*) n FROM sessions WHERE revoked_at IS NULL", "SELECT count(*) n FROM consents WHERE status='granted'",'SELECT count(*) n FROM media_grants WHERE active=1','SELECT count(*) n FROM media_tickets','SELECT count(*) n FROM download_tickets',"SELECT count(*) n FROM restore_cleanup_objects WHERE recovery_id=$1 AND status IN('pending','blocked')"];
   for(const sql of checks){const result=await c.query<{n:number}>(sql,sql.includes('$1')?[id]:[]);if(Number(result[0]?.n)!==0)return bad('restore_clearance_incomplete');}
   // Version2 writers always register an independent effect before PUT. Once
   // this cut and complete namespace scan are fixed, a missing registration
   // proves that a new-protocol intent never dispatched; old writers stay held.
   await c.query("UPDATE media_write_intents m SET status='settled',settled_at=coalesce(settled_at,$1) WHERE m.status='pending' AND m.restore_protocol_version=2 AND m.restore_incarnation_id=$2 AND NOT EXISTS(SELECT 1 FROM restore_cleanup_objects o WHERE o.recovery_id=$3 AND o.bucket=m.bucket AND o.object_key=m.object_key AND o.effect_id NOT LIKE 'scan:%')",[this.now(),view.recovery.prior_marker.incarnation_id,id]);
   const pending=await c.query<{n:number}>("SELECT count(*) n FROM media_write_intents WHERE status='pending'",[]);if(Number(pending[0]?.n)!==0)return bad('restore_uninventoried_writer');
   let cursor='',count=0,root=ZERO;
   for(;;){
    const records=await c.query<any>('SELECT effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json FROM restore_cleanup_objects WHERE recovery_id=$1 AND effect_id>$2 ORDER BY effect_id LIMIT 32',[id,cursor]);
    for(const record of records){const proof=JSON.parse(record.proof_json);delete proof.verified_at;
     root=await digest(stable({previous_hash:root,record:{...record,proof_json:stable(proof)}}));count++;cursor=record.effect_id;}
    if(records.length<32)break;
   }
   return digest(stable({kind:'restored-authority-and-inventory-v2',recovery_id:id,generation_hash:view.recovery.generation_hash,retired_at:Number(row.retired_at),inventory_count:count,inventory_root:root}));
  });
 }
 /** Only a protocol-v2 intent with no independent dispatch can establish a
  * never-written key. Old absent SQL rows are not writer terminality evidence. */
 private async erasureCleanupStep(view:RecoveryView):Promise<boolean>{
  return this.guarded(view,async c=>{
   const rows=await c.query<any>(`SELECT x.* FROM cleanup_intents x JOIN privacy_requests p ON p.id=x.request_id
    WHERE EXISTS(SELECT 1 FROM restore_replay_facts f WHERE f.kind='account-erased' AND f.sequence<=$2
      AND f.scope_json::jsonb->>'account_id'=x.subject_id AND f.scope_json::jsonb->>'deletion_request_id'=x.request_id)
    AND NOT EXISTS(SELECT 1 FROM restore_cleanup_objects o WHERE o.recovery_id=$1 AND o.bucket=x.bucket AND o.object_key=x.object_key AND o.status='absent'
      AND (o.proof_json::jsonb->>'verified_at')::bigint>=p.metadata_erased_at)
    ORDER BY x.id LIMIT 1`,[view.recovery.recovery_id,view.recovery.journal_head.sequence]);
   if(!rows.length)return true;const row=rows[0],name=row.bucket as typeof buckets[number];if(!buckets.includes(name))return bad('restore_cleanup_bucket_unverified');
   const writers=await c.query<any>('SELECT account_id,restore_protocol_version,restore_incarnation_id FROM media_write_intents WHERE bucket=$1 AND object_key=$2',[name,row.object_key]);
   if(!writers.length||writers.some(w=>w.account_id!==row.subject_id||Number(w.restore_protocol_version)!==2||w.restore_incarnation_id!==view.recovery.prior_marker.incarnation_id))return bad('restore_legacy_cleanup_unqualified');
   const existing=await c.query<any>("SELECT effect_id,status FROM restore_cleanup_objects WHERE recovery_id=$1 AND bucket=$2 AND object_key=$3 AND effect_id NOT LIKE 'scan:%'",[view.recovery.recovery_id,name,row.object_key]);
   if(existing.length)return bad('restore_cleanup_proof_conflict');
   if(await this.storage[name].head(row.object_key)!==null)return bad('restore_unknown_object_preserved');
   const at=this.now(),proof={outcome:'absent',sha256:null,byte_size:null,etag:null,reference_hash:null,verified_at:at};
   await c.query("INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json,updated_at) VALUES($1,$2,$3,$4,$5,0,'absent',$6,$7)",[view.recovery.recovery_id,'cleanup:'+row.id,name,row.object_key,ZERO,stable(proof),at]);
   await c.query("UPDATE cleanup_intents SET status='verified',verified_at=$1 WHERE id=$2 AND subject_id=$3 AND bucket=$4 AND object_key=$5",[at,row.id,row.subject_id,name,row.object_key]);
   await c.query("UPDATE media_write_intents SET status='settled',settled_at=coalesce(settled_at,$1) WHERE bucket=$2 AND object_key=$3",[at,name,row.object_key]);
   return false;
  });
 }
 private async recordCompletion(view:RecoveryView):Promise<void>{
  if(view.progress.phase!=='completed')return bad();
  await this.connection.begin(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);await c.query('SET LOCAL ROLE lovelies_api',[]);
   await c.query('SET LOCAL search_path TO lovelies_private,pg_catalog',[]);await c.query("SELECT set_config('lovelies.restore_replay','on',true)",[]);
   const current=await this.read(view.recovery.recovery_id),control=await this.journal.control();
   if(current.progress.phase!=='completed'||current.recovery.generation_hash!==view.recovery.generation_hash||current.progress.clearance.clearance_hash!==view.progress.clearance.clearance_hash)return bad();
   // The audit acknowledgement never rewinds a later marker or retires new
   // authority. A concurrent/pending new operation can finish the audit later.
   if(control.state!=='serving'||control.pending_operation_id!==null||control.marker.incarnation_id!==view.recovery.incarnation_id)return;
   const sql=(await c.query<any>('SELECT * FROM restore_control WHERE singleton=1',[]))[0];
   if(!sql||sql.database_id!==control.marker.database_id||sql.incarnation_id!==control.marker.incarnation_id||Number(sql.checkpoint_revision)!==control.marker.checkpoint.revision||sql.checkpoint_hash!==control.marker.checkpoint.hash||Number(sql.journal_sequence)!==control.marker.cursor.sequence||sql.journal_hash!==control.marker.cursor.hash)return;
   await c.query("UPDATE restore_recovery_runs SET state='complete',updated_at=$1 WHERE id=$2 AND generation_hash=$3 AND state='prepared' AND clearance_json::jsonb->>'clearance_hash'=$4",[this.now(),view.recovery.recovery_id,view.recovery.generation_hash,view.progress.clearance.clearance_hash]);
  });
 }
 async step(id:string):Promise<{phase:string;recovery:RecoveryView}>{
  let view=await this.read(id);if(view.progress.phase==='completed'){await this.recordCompletion(view);return {phase:'completed',recovery:view};}
  if(view.progress.replayed.sequence<view.recovery.journal_head.sequence){
   const records=await this.journal.restrictionPage(view.progress.replayed,view.recovery.journal_head);const last=records.at(-1);if(!last)return bad();
   await this.guarded(view,async c=>{for(const receipt of records)await applyRestrictionReceipt(c,receipt,receipt.recorded_at);
    await c.query('UPDATE restore_recovery_runs SET replayed_sequence=$1,replayed_hash=$2,updated_at=$3 WHERE id=$4',[last.sequence,last.hash,this.now(),id]);});
   view=await this.request('/v1/recovery/'+id+'/replay',this.body(view,{after:view.progress.replayed,next:{sequence:last.sequence,hash:last.hash}}));return {phase:'replaying',recovery:view};
  }
  await this.guarded(view,c=>this.retireAuthority(c,view));
  const recoveryContext=this.recoveryContext(view);
  if(await recoveryContext.db.one('SELECT id FROM managed_auth_bindings WHERE user_deleted_at IS NULL LIMIT 1')){
   await maintainManagedAuth(recoveryContext,8);
   if(await recoveryContext.db.one('SELECT id FROM managed_auth_bindings WHERE user_deleted_at IS NULL LIMIT 1'))return {phase:'managed-auth-retirement',recovery:view};
  }
  if(!await this.erasureStep(recoveryContext,view)){return {phase:'erasure-metadata',recovery:view};}
  const page=await this.effectPage(view.progress.effect_sequence);
  if(page.head.sequence!==view.recovery.effect_head.sequence||page.head.hash!==view.recovery.effect_head.hash)return bad('restore_effect_inventory_changed');
  if(!equal({sequence:page.head.observation_sequence,hash:page.head.observation_hash},view.progress.observation_head)){
   view=await this.request('/v1/recovery/'+id+'/refresh-effects',this.body(view));return {phase:'effects-refreshed',recovery:view};
  }
  if(view.progress.effect_sequence<view.recovery.effect_head.sequence){
   try{if(!page.effects.length)return bad();view=await this.reconcileEffect(view,page.effects[0]);}
   catch(error){if(error instanceof ApiError&&error.code==='recovery_effect_cut_changed'){view=await this.request('/v1/recovery/'+id+'/refresh-effects',this.body(view));return {phase:'effects-refreshed',recovery:view};}throw error;}
   return {phase:'effects',recovery:view};
  }
  if(!await this.inventoryStep(view))return {phase:'storage-inventory',recovery:view};
  if(!await this.erasureCleanupStep(view))return {phase:'erasure-cleanup',recovery:view};
  // Retire never-dispatched v2 writers before the erasure finalizer's exact
  // zero-writer check. The same checks/hash are repeated before installing SQL.
  await this.clearanceHash(view);
  if(!await this.erasureStep(recoveryContext,view,true))return {phase:'erasure-completion',recovery:view};
  if(view.progress.retirement_hash===null){const retirement_hash=await this.clearanceHash(view);view=await this.request('/v1/recovery/'+id+'/retire-authority',this.body(view,{retirement_hash}));}
  if(view.progress.phase!=='prepared')view=await this.request('/v1/recovery/'+id+'/prepare-clearance',this.body(view));
  const clearance=view.progress.clearance;
  if(await this.clearanceHash(view)!==view.progress.retirement_hash)return bad('restore_clearance_changed');
  await this.guarded(view,async c=>{
   // Recompute, rather than trusting an old locally stored green flag.
   const row=(await c.query<any>('SELECT * FROM restore_recovery_runs WHERE id=$1',[id]))[0];if(!row||row.retired_at===null)return bad();
   const next=clearance.marker;await c.query('UPDATE restore_control SET incarnation_id=$1,checkpoint_revision=$2,checkpoint_hash=$3,journal_sequence=$4,journal_hash=$5,last_operation_id=$6,last_plan_hash=$7 WHERE singleton=1',[next.incarnation_id,next.checkpoint.revision,next.checkpoint.hash,next.cursor.sequence,next.cursor.hash,id,clearance.clearance_hash]);
   if(view.recovery.prior_pending_operation_id){const prior=await this.journal.lookup(view.recovery.prior_pending_operation_id);if(!prior)return bad();await c.query("INSERT INTO restore_recovered_operations(operation_id,input_hash,plan_hash,outcome,recovered_at) VALUES($1,$2,$3,'restore-retired',$4) ON CONFLICT(operation_id) DO NOTHING",[prior.plan.operation_id,prior.plan.input_hash,prior.plan_hash,this.now()]);}
   await c.query("UPDATE restore_recovery_runs SET state='prepared',clearance_json=$1,updated_at=$2 WHERE id=$3",[stable(clearance),this.now(),id]);
  });
  view=await this.request('/v1/recovery/'+id+'/complete',this.body(view,{clearance_hash:clearance.clearance_hash,marker:clearance.marker}));
  await this.recordCompletion(view);
  return {phase:'completed',recovery:view};
 }
}
