import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { requireOperator, mediaHeld } from './operators.ts';
import { executeOperation, prepareOperation } from './operations.ts';
import { accountRoles } from './auth.ts';
import { assertMediaActor, hasConsent } from './gallery.ts';
import { assertGeneration } from './inference-generation.ts';
import { audienceContext } from './audience.ts';

const transientFailures = new Set(['photo_processor_unavailable','photo_processing_unavailable','processing_failed']);
const MAX_DAILY_RESUMES = 3;
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
async function readSnapshot(ctx:AppContext,assetId:string,attemptId:string) {
  const asset = await ctx.db.one<any>("SELECT * FROM assets WHERE id=? AND source='personal' AND deleted_at IS NULL",assetId);
  const attempt = await ctx.db.one<any>('SELECT * FROM processing_attempts WHERE id=? AND asset_id=?',attemptId,assetId);
  if (!asset || !attempt) throw new ApiError(404,'processing_attempt_not_found');
  const jobId = await digest(stable({category:'photo',payload:{attempt_id:attemptId}}));
  const job = await ctx.db.one<any>('SELECT * FROM job_queue WHERE id=?',jobId);
  const outbox = await ctx.db.one<any>('SELECT * FROM photo_job_outbox WHERE attempt_id=?',attemptId);
  const session = await ctx.db.one<any>(`SELECT s.*,a.roles_json,a.auth_epoch account_auth_epoch,a.disabled_at FROM sessions s
    JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.account_id=?`,attempt.owner_session_id,attempt.owner_id);
  const hold = await mediaHeld(ctx,asset.owner_id,assetId);
  const audience = await audienceContext(ctx,asset.owner_id,'photo_processing');
  const consent = await hasConsent(ctx,asset.owner_id,'photo_processing');
  // A delayed private write from any same-account job can still arrive. Do not
  // clear that evidence or claim a safe restart based on elapsed lease time.
  const unresolvedWriter = await ctx.db.one('SELECT id FROM media_write_intents WHERE account_id=? AND status=\'pending\' LIMIT 1',asset.owner_id);
  const resumes = (await ctx.db.one<{n:number}>(`SELECT count(*) n FROM operations WHERE source='operator_recovery' AND action='operator.photo.resume'
    AND json_extract(payload_json,'$.attempt_id')=? AND created_at>?`,attemptId,ctx.now()-86400000))?.n ?? 0;
  let reason:string|null = null;
  if (hold) reason='moderation_hold';
  else if (!['queued','running','failed'].includes(attempt.status) || !['processing','failed'].includes(asset.status)) reason='processing_terminal';
  else if (attempt.status === 'failed' && !transientFailures.has(attempt.error_code)) reason='fresh_owner_action_required';
  else if (attempt.expires_at <= ctx.now()) reason='processing_attempt_expired';
  else if (attempt.status === 'running' && (!Number.isSafeInteger(attempt.lease_until) || typeof attempt.lease_token !== 'string') ||
      job?.state === 'processing' && (!Number.isSafeInteger(job.lease_until) || typeof job.lease_token !== 'string')) reason='job_handoff_unverified';
  else if (attempt.lease_until > ctx.now() || job?.state === 'processing' && job.lease_until > ctx.now()) reason='processing_in_progress';
  else if (unresolvedWriter) reason='external_write_unconfirmed';
  else if (asset.owner_id !== attempt.owner_id || asset.version !== attempt.source_version || asset.checksum_sha256 !== attempt.source_checksum_sha256) reason='processing_origin_changed';
  else if (!consent || !audience) reason='processing_consent_required';
  else if (resumes >= MAX_DAILY_RESUMES) reason='operator_recovery_budget_exhausted';
  else if (job && (job.category !== 'photo' || job.payload_json !== stable({attempt_id:attemptId}) || !['pending','processing','failed','completed'].includes(job.state))) reason='job_handoff_unverified';
  else if (outbox && (outbox.asset_id !== assetId || !['pending','dispatched'].includes(outbox.status))) reason='job_handoff_unverified';
  if (!reason) {
    try {
      if (!session || session.revoked_at !== null || session.auth_epoch !== attempt.owner_auth_epoch || session.account_auth_epoch !== attempt.owner_auth_epoch)
        throw new ApiError(401,'session_revoked');
      const owner:Actor = {accountId:attempt.owner_id,sessionId:session.id,roles:accountRoles(session.roles_json),authEpoch:session.auth_epoch,
        authMethod:session.auth_method,expiresAt:session.expires_at};
      await assertMediaActor(ctx,owner);
      if (attempt.model_version !== ctx.env.PHOTO_MODEL_VERSION) throw new ApiError(409,'inference_generation_changed');
      assertGeneration(attempt.engine_identity,ctx.env);
    } catch { reason='owner_authority_changed'; }
  }
  const revision = await digest(stable({protocol:'lovelies-operator-recovery-v1',asset,attempt,job,outbox,session,
    hold,audience,consent,unresolvedWriter,resumes,model:ctx.env.PHOTO_MODEL_VERSION,engine:ctx.env.INFERENCE_ENGINE_IDENTITY}));
  return {asset,attempt,job,outbox,jobId,revision,reason};
}
export async function photoRecoveryDiagnostics(ctx:AppContext,assetId:string,attemptId:string) {
  const state = await readSnapshot(ctx,assetId,attemptId);
  return {protocol:'lovelies-operator-recovery-v1',eligible:state.reason === null,reason:state.reason,
    expected_revision:state.revision,action:'resume_original_attempt',maximum_daily_resumes:MAX_DAILY_RESUMES};
}
async function applyResume(ctx:AppContext,actor:Actor,state:Snapshot,reason:string) {
  const {asset,attempt,job,outbox,jobId} = state;
  await ctx.db.run("UPDATE processing_attempts SET status='queued',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=?",attempt.id);
  await ctx.db.run("UPDATE assets SET status='processing' WHERE id=? AND version=?",asset.id,attempt.source_version);
  if (!outbox) await ctx.db.run("INSERT INTO photo_job_outbox(id,attempt_id,asset_id,status,created_at) VALUES(?,?,?,'pending',?)",crypto.randomUUID(),attempt.id,asset.id,ctx.now());
  else await ctx.db.run("UPDATE photo_job_outbox SET status='pending' WHERE id=?",outbox.id);
  if (!job) await ctx.db.run("INSERT INTO job_queue(id,category,payload_json,state,available_at,created_at) VALUES(?,'photo',?,'pending',?,?)",jobId,stable({attempt_id:attempt.id}),ctx.now(),ctx.now());
  else {
    // Retain scheduler backoff and past attempt/error evidence. Only expired
    // leases are retired, and a late worker must fail its original token CAS.
    await ctx.db.run("UPDATE job_queue SET state='pending',lease_token=NULL,lease_until=NULL,completed_at=NULL,handoff_count=handoff_count+1,available_at=greatest(available_at,?) WHERE id=?",ctx.now(),jobId);
  }
  await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
    crypto.randomUUID(),actor.accountId,asset.owner_id,'operator.photo.resume',attempt.id,stable({asset_id:asset.id,reason,expected_revision:state.revision}),ctx.now());
  return {protocol:'lovelies-operator-recovery-v1',asset_id:asset.id,attempt_id:attempt.id,state:'queued',
    original_authority_preserved:true,completed:false,grants_created:0};
}
export async function handleOperatorRecovery(request:Request,ctx:AppContext):Promise<Response|null> {
  const url = new URL(request.url),route = /^\/admin\/uploads\/([0-9a-f-]{36})\/attempts\/([0-9a-f-]{36})\/resume$/i.exec(url.pathname);
  if (!route) return null;
  if (request.method !== 'POST') throw new ApiError(405,'method_not_allowed');
  if (url.search) throw new ApiError(400,'invalid_input');
  const actor = await ctx.authenticate(request);
  await requireOperator(ctx,actor,true,'uploads.recover');
  const assetId=uuid(route[1]),attemptId=uuid(route[2]),body=await jsonBody(request,4096);
  if (Object.keys(body).some(key=>!['expected_revision','reason','operation_key'].includes(key)) || typeof body.expected_revision !== 'string' ||
      !/^[0-9a-f]{64}$/.test(body.expected_revision) || typeof body.reason !== 'string' || body.reason.trim().length<3 || body.reason.trim().length>1000 || /[\x00-\x1f\x7f]/.test(body.reason))
    throw new ApiError(400,'operator_recovery_input_invalid');
  const intent = await prepareOperation('operator.photo.resume',{...body,reason:body.reason.trim(),asset_id:assetId,attempt_id:attemptId},'operator_recovery');
  // Obtain the head without holding a database lock. Exact metadata and all
  // mutable authority are rechecked in the operation transaction below.
  const admitted=await ctx.db.transaction(async()=>{
    await requireOperator(ctx,actor,true,'uploads.recover');
    if(await ctx.db.one('SELECT operation_key FROM operations WHERE actor_id=? AND source=? AND operation_key=?',actor.accountId,intent.source,intent.key)) {
      const receipt=await executeOperation(ctx,actor,intent,async()=>{throw new ApiError(503,'operation_receipt_unavailable');});
      return {receipt} as const;
    }
    return {snapshot:await readSnapshot(ctx,assetId,attemptId)} as const;
  });
  if('receipt' in admitted)return ok(admitted.receipt);
  const initial=admitted.snapshot;
  const head = await ctx.env.QUARANTINE.head(initial.asset.object_key);
  return ok(await ctx.db.transaction(async()=>{
    await requireOperator(ctx,actor,true,'uploads.recover');
    return executeOperation(ctx,actor,intent,async()=>{
      await requireOperator(ctx,actor,true,'uploads.recover');
      const current=await readSnapshot(ctx,assetId,attemptId);
      if (current.asset.owner_id === actor.accountId) throw new ApiError(403,'independent_review_required');
      if (current.revision !== body.expected_revision || initial.revision !== current.revision) throw new ApiError(409,'operator_recovery_revision_changed');
      if (current.reason) throw new ApiError(409,current.reason);
      if (!head || head.size !== current.asset.byte_size || head.customMetadata?.source_version !== current.attempt.source_version ||
          head.customMetadata?.source_checksum_sha256 !== current.attempt.source_checksum_sha256) throw new ApiError(409,'source_unverified');
      return applyResume(ctx,actor,current,body.reason.trim());
    },[initial.asset.owner_id]);
  }));
}
