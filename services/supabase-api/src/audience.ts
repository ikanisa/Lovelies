import { ApiError, jsonBody, ok, stable, uuid, type Actor, type AppContext, type Database } from './types.ts';
import { assertPrivacyActor } from './auth.ts';
import { executeRestrictedOperation, prepareOperation, assertRegisteredActor } from './operations.ts';
import { requireOperator } from './operators.ts';

export const AUDIENCE_POLICY = 'audience-2026-10-24-v1';
export const AUDIENCE_PROTOCOL = 'lovelies-audience-v1';
export const audiencePurposes = ['face_authentication', 'photo_matching', 'photo_processing'] as const;
export type AudiencePurpose = typeof audiencePurposes[number];
const DAY = 86400000;
type Audience = { account_id: string; age_band: 'under13' | '13_17' | '18_plus'; status: string; version: number; declared_at: number; policy_version: string; next_review_at: number | null };
type Guardian = { id: string; child_account_id: string; guardian_account_id: string | null; state: string; child_audience_version: number; policy_version: string; created_at: number; expires_at: number; revision: number; reviewed_by: string | null; reviewed_at: number | null; evidence_method: string | null; evidence_reference: string | null; terminated_at: number | null };
export const audienceSchemaStatements: readonly string[] = [
 `CREATE TABLE IF NOT EXISTS account_audience(account_id TEXT PRIMARY KEY REFERENCES accounts(id),age_band TEXT NOT NULL CHECK(age_band IN('under13','13_17','18_plus')),status TEXT NOT NULL CHECK(status IN('blocked','guardian_pending','eligible','suspended')),version INTEGER NOT NULL CHECK(version>0),declared_at INTEGER NOT NULL,policy_version TEXT NOT NULL,next_review_at INTEGER)`,
 `CREATE TABLE IF NOT EXISTS guardian_requests(id TEXT PRIMARY KEY,child_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_account_id TEXT REFERENCES accounts(id),state TEXT NOT NULL CHECK(state IN('pending','under_review','approved','rejected','withdrawn','expired')),child_audience_version INTEGER NOT NULL CHECK(child_audience_version>0),policy_version TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),reviewed_by TEXT REFERENCES accounts(id),reviewed_at INTEGER,evidence_method TEXT,evidence_reference TEXT,terminated_at INTEGER,CHECK(guardian_account_id IS NULL OR guardian_account_id<>child_account_id),CHECK(reviewed_by IS NULL OR (reviewed_by<>child_account_id AND reviewed_by<>guardian_account_id)))`,
 `CREATE INDEX IF NOT EXISTS guardian_child_state ON guardian_requests(child_account_id,state,expires_at)`,
 `CREATE TABLE IF NOT EXISTS guardian_purpose_approvals(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES guardian_requests(id) ON DELETE CASCADE,child_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_account_id TEXT NOT NULL REFERENCES accounts(id),guardian_audience_version INTEGER NOT NULL CHECK(guardian_audience_version>0),purpose TEXT NOT NULL CHECK(purpose IN('face_authentication','photo_matching','photo_processing')),policy_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('requested','approved','revoked')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(request_id,purpose),CHECK(child_account_id<>guardian_account_id))`,
 `CREATE TABLE IF NOT EXISTS audience_adult_reviews(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),reviewed_by TEXT NOT NULL REFERENCES accounts(id),evidence_method TEXT NOT NULL,evidence_reference TEXT NOT NULL,created_at INTEGER NOT NULL,CHECK(account_id<>reviewed_by))`,
 `CREATE INDEX IF NOT EXISTS guardian_purpose_child ON guardian_purpose_approvals(child_account_id,purpose,status)`,
];
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const purposePolicy = (ctx: AppContext, purpose: AudiencePurpose): string => purpose === 'face_authentication' ? ctx.env.FACE_AUTH_POLICY_VERSION ?? '' : ctx.env.PHOTO_CONSENT_POLICY_VERSION ?? ctx.env.PHOTO_MODEL_VERSION ?? '';
const exact = (body: Record<string, unknown>, allowed: readonly string[]) => { if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'audience_input_invalid'); };
function policy(body: Record<string, unknown>): void { if (body.policy_version !== AUDIENCE_POLICY) throw new ApiError(409, 'audience_policy_changed'); }
const row = (ctx: AppContext, account: string) => ctx.db.one<Audience>('SELECT * FROM account_audience WHERE account_id=?', account);

/** No declaration is inferred from a session, existing profile, store age rating,
 * device, face result, imported row, or absent configuration. */
export async function audienceContext(ctx: AppContext, account: string, purpose: AudiencePurpose): Promise<string | null> {
 const a = await row(ctx, account), now = ctx.now();
 if (!a || a.policy_version !== AUDIENCE_POLICY || a.status !== 'eligible' || a.age_band === 'under13' || a.next_review_at !== null && a.next_review_at <= now || !purposePolicy(ctx, purpose)) return null;
 if (await ctx.db.one("SELECT id FROM accounts WHERE id=? AND disabled_at IS NOT NULL", account) || await ctx.db.one("SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND status IN('pending_approval','approved','queued','processing','failed') LIMIT 1", account)) return null;
 if (a.age_band === '18_plus') return stable({ policy: a.policy_version, version: a.version, purpose });
 const approvals = await ctx.db.all<any>(`SELECT p.*,r.revision request_revision,r.reviewed_by,r.reviewed_at,r.expires_at request_expires_at,g.version guardian_version
 FROM guardian_purpose_approvals p JOIN guardian_requests r ON r.id=p.request_id AND r.child_account_id=p.child_account_id AND r.guardian_account_id=p.guardian_account_id
 JOIN account_audience g ON g.account_id=p.guardian_account_id AND g.age_band='18_plus' AND g.status='eligible' AND g.policy_version=? AND g.version=p.guardian_audience_version
 JOIN accounts ga ON ga.id=g.account_id AND ga.disabled_at IS NULL AND ga.identity_state='registered_face'
 JOIN face_profiles fp ON fp.account_id=ga.id AND fp.status='active' AND fp.auth_enabled=1
 JOIN consents c ON c.id=fp.auth_consent_id AND c.account_id=ga.id AND c.purpose='face_authentication' AND c.status='granted' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?) AND c.policy_version=?
 WHERE p.child_account_id=? AND p.purpose=? AND p.policy_version=? AND p.status='approved' AND p.revoked_at IS NULL AND p.expires_at>?
 AND r.state='approved' AND r.policy_version=? AND r.child_audience_version=? AND r.expires_at>? AND r.reviewed_at IS NOT NULL AND r.reviewed_by<>r.child_account_id AND r.reviewed_by<>r.guardian_account_id
 AND (g.next_review_at IS NULL OR g.next_review_at>?)
 AND NOT EXISTS(SELECT 1 FROM privacy_requests d WHERE d.subject_id=ga.id AND d.request_type='delete' AND d.status IN('pending_approval','approved','queued','processing','failed'))
 ORDER BY p.id LIMIT 1`, AUDIENCE_POLICY, now, ctx.env.FACE_AUTH_POLICY_VERSION ?? '', account, purpose, purposePolicy(ctx, purpose), now, AUDIENCE_POLICY, a.version, now, now);
 const p = approvals[0];
 return p ? stable({ policy: a.policy_version, version: a.version, purpose, approval: p.id, approval_version: p.version, request: p.request_id, request_revision: p.request_revision, guardian_version: p.guardian_version }) : null;
}
export async function assertAudienceCapability(ctx: AppContext, account: string, purpose: AudiencePurpose, expected?: string | null): Promise<string> {
 const current = await audienceContext(ctx, account, purpose);
 if (!current) {
  const a = await row(ctx, account);
  if (!a || a.policy_version !== AUDIENCE_POLICY) throw new ApiError(403, 'audience_required');
  if (a.age_band === 'under13') throw new ApiError(403, 'age_not_supported');
  throw new ApiError(403, a.age_band === '13_17' ? 'guardian_approval_required' : 'audience_restricted');
 }
 if (expected !== undefined && current !== expected) throw new ApiError(409, 'audience_authority_changed');
 return current;
}
export async function audienceChallengeAuthority(ctx: AppContext, challenge: { id: string; account_id: string; device_id: string; purpose: string; expires_at: number }): Promise<Record<string, unknown>> {
 await assertAudienceCapability(ctx, challenge.account_id, 'face_authentication');
 const a = (await row(ctx, challenge.account_id))!;
 return { protocol: 'lovelies-audience-challenge-v1', account_id: challenge.account_id, challenge_id: challenge.id, device_id: challenge.device_id, purpose: challenge.purpose, policy_version: AUDIENCE_POLICY, audience_version: a.version, expires_at: iso(challenge.expires_at) };
}
async function requestProjection(ctx: AppContext, request: Guardian): Promise<Record<string, unknown>> {
 const purposes: Record<string, boolean> = {};
 for (const purpose of audiencePurposes) {
  const current=request.state==='approved'&&request.expires_at>ctx.now()?await audienceContext(ctx,request.child_account_id,purpose):null;
  purposes[purpose]=current!==null&&JSON.parse(current).request===request.id;
 }
 return { id: request.id, child_account_id: request.child_account_id, state: request.expires_at <= ctx.now() && ['pending','under_review','approved'].includes(request.state) ? 'expired' : request.state, revision: request.revision, policy_version: request.policy_version, created_at: iso(request.created_at), expires_at: iso(request.expires_at), purposes };
}
export async function audienceProjection(ctx: AppContext, account: string): Promise<Record<string, unknown>> {
 const a = await row(ctx, account), guardian = await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE child_account_id=? ORDER BY created_at DESC,id DESC LIMIT 1', account), capabilities: Record<string, boolean> = {};
 for (const purpose of audiencePurposes) capabilities[purpose] = !!await audienceContext(ctx, account, purpose);
 return { protocol: AUDIENCE_PROTOCOL, policy_version: AUDIENCE_POLICY, account_id: account, audience: a ? { age_band:a.age_band,status:a.age_band==='13_17'&&!capabilities.face_authentication?'guardian_pending':a.status,version:a.version,policy_version:a.policy_version,next_review_at:iso(a.next_review_at) } : { age_band:'unknown',status:'unknown',version:0,policy_version:null,next_review_at:null }, guardian_request: guardian ? await requestProjection(ctx, guardian) : null, capabilities };
}
async function audit(ctx: AppContext, actor: string, subject: string, action: string, entity: string): Promise<void> {
 await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),actor,subject,action,entity,'{}',ctx.now());
}
/** Audience revocation preserves the durable session for status/privacy and
 * security controls, while product checks use the incremented audience version.
 * Neither a later approval nor an idempotent replay restores previous consents. */
export async function revokeAudienceAuthority(ctx: AppContext, account: string, reason: string): Promise<void> {
 const now=ctx.now();
 await ctx.db.run("UPDATE account_audience SET status=CASE WHEN age_band='under13' THEN 'blocked' ELSE 'suspended' END,version=version+1 WHERE account_id=?",account);
 await ctx.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose IN('face_authentication','photo_matching','photo_processing') AND status='granted'",now,account);
 await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE account_id=? AND used_at IS NULL",now,account);
 await ctx.db.run('UPDATE face_enrollment_intents SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?',now,account);
 await ctx.db.run('UPDATE face_recovery_keys SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?',now,account);
 await ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND state='pending'",account);
 await ctx.db.run("UPDATE processing_attempts SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_id=? AND status<>'completed'",account);
 await ctx.db.run("UPDATE photo_job_outbox SET status='cancelled' WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)",account);
 await ctx.db.run("UPDATE candidates SET status='invalidated',version=? WHERE owner_id=? OR recipient_id=?",crypto.randomUUID(),account,account);
 await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE owner_id=? OR recipient_id=?',now,account,account);
 await ctx.db.run('DELETE FROM media_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)',account,account);
 await ctx.db.run('DELETE FROM download_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)',account,account);
 await ctx.db.run("UPDATE sharing_requests SET status='revoked',updated_at=? WHERE (sender_id=? OR recipient_id=?) AND status IN('requested','accepted')",now,account,account);
 const profile=await ctx.db.one<any>('SELECT * FROM face_profiles WHERE account_id=?',account);
 if(profile){
  await ctx.db.run("UPDATE face_profiles SET status='revoked',auth_enabled=0,auth_epoch=auth_epoch+1 WHERE account_id=?",account);
  if(!await ctx.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=? AND template_key=?',account,profile.template_key)){
   const cleanup=crypto.randomUUID();
   await ctx.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",cleanup,account,profile.template_key,now);
   await ctx.db.run('INSERT INTO face_profile_retirements(cleanup_id,account_id,operation_key,profile_id,profile_revision,template_key,template_digest) VALUES(?,?,?,?,?,?,?)',cleanup,account,'audience:'+reason,profile.id,profile.revision,profile.template_key,profile.template_digest);
  }
 }
}
async function retireGuardianRequest(ctx: AppContext, request: Guardian, state: 'withdrawn'|'expired'|'rejected', actor: string): Promise<void> {
 if (!['pending','under_review','approved'].includes(request.state)) return;
 await ctx.db.run('UPDATE guardian_requests SET state=?,revision=revision+1,terminated_at=? WHERE id=?',state,ctx.now(),request.id);
 await ctx.db.run("UPDATE guardian_purpose_approvals SET status='revoked',version=version+1,revoked_at=coalesce(revoked_at,?) WHERE request_id=?",ctx.now(),request.id);
 await audit(ctx,actor,request.child_account_id,'guardian.'+state,request.id);
}
async function terminate(ctx: AppContext, request: Guardian, state: 'withdrawn'|'expired'|'rejected', actor: string): Promise<void> {
 const current=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE id=?',request.id);
 if(!current||!['pending','under_review','approved'].includes(current.state)) return;
 const a=await row(ctx,current.child_account_id);
 // A retired relationship controls neither a reviewed adult declaration nor a
 // newer guardian episode. Expiry cleanup must not revoke the replacement.
 const replacement=await ctx.db.one("SELECT id FROM guardian_requests WHERE child_account_id=? AND child_audience_version=? AND id<>? AND state IN('pending','under_review','approved') AND expires_at>? LIMIT 1",current.child_account_id,current.child_audience_version,current.id,ctx.now());
 const controlsCurrent=a?.age_band==='13_17'&&a.version===current.child_audience_version&&a.policy_version===current.policy_version&&!replacement;
 await retireGuardianRequest(ctx,current,state,actor);
 if(controlsCurrent){
  await revokeAudienceAuthority(ctx,current.child_account_id,current.id);
  await ctx.db.run("UPDATE account_audience SET status='guardian_pending' WHERE account_id=? AND age_band='13_17'",current.child_account_id);
 }
}
async function guardianAdult(ctx: AppContext, actor: Actor): Promise<void> {
 await assertRegisteredActor(ctx,actor);
 const a=await row(ctx,actor.accountId);
 if(a?.age_band!=='18_plus'||a.status!=='eligible') throw new ApiError(403,'guardian_adult_required');
}
async function owned(ctx: AppContext, actor: Actor, id: string): Promise<Guardian> {
 const r=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE id=?',id);
 if(!r||(r.child_account_id!==actor.accountId&&r.guardian_account_id!==actor.accountId)) throw new ApiError(404,'guardian_request_unavailable');
 return r;
}
function evidence(body: Record<string, unknown>): void {
 if(!['independent_live_review','independent_document_review'].includes(String(body.evidence_method))||typeof body.evidence_reference!=='string'||!/^[A-Za-z0-9._:-]{16,128}$/.test(body.evidence_reference)) throw new ApiError(400,'guardian_evidence_required');
}
export async function handleAudience(request: Request,ctx: AppContext):Promise<Response|null>{
 const path=new URL(request.url).pathname, own=/^\/me\/guardian-requests\/([0-9a-f-]{36})$/i.exec(path), action=/^\/guardian-requests\/([0-9a-f-]{36})\/(claim|withdraw)$/i.exec(path), review=/^\/admin\/guardian-requests\/([0-9a-f-]{36})\/review$/i.exec(path), adult=/^\/admin\/audience\/([0-9a-f-]{36})\/adult-review$/i.exec(path);
 if(!['/me/audience','/me/guardian-requests','/admin/guardian-requests'].includes(path)&&!own&&!action&&!review&&!adult)return null;
 const actor=await ctx.authenticate(request);await assertPrivacyActor(actor,ctx);
 if(request.method==='GET')return ctx.db.transaction(async()=>{
  await assertPrivacyActor(actor,ctx);
  if(path==='/me/audience')return ok(await audienceProjection(ctx,actor.accountId));
  if(own)return ok({guardian_request:await requestProjection(ctx,await owned(ctx,actor,uuid(own[1])))});
  if(path==='/admin/guardian-requests'){
   await requireOperator(ctx,actor,true);await guardianAdult(ctx,actor);
   const requests=await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE state IN('pending','under_review','approved') ORDER BY created_at,id LIMIT 100");
   return ok({guardian_requests:await Promise.all(requests.map(async r=>({...await requestProjection(ctx,r),guardian_account_id:r.guardian_account_id,reviewed_at:iso(r.reviewed_at),requested_purposes:(await ctx.db.all<{purpose:string}>('SELECT purpose FROM guardian_purpose_approvals WHERE request_id=? ORDER BY purpose',r.id)).map(p=>p.purpose),evidence_recorded:r.reviewed_at!==null&&r.evidence_method!==null&&r.evidence_reference!==null})))});
  }
  throw new ApiError(405,'method_not_allowed');
 });
 if(request.method!==(path==='/me/audience'?'PUT':'POST'))throw new ApiError(405,'method_not_allowed');
 const body=await jsonBody(request,4096);
 const intent=await prepareOperation(path==='/me/audience'?'audience.declare':adult?'audience.adult-review':review?'guardian.review':action?'guardian.'+action[2]:'guardian.create',{...body,...(own||action||review||adult?{target_id:uuid((own??action??review??adult)![1])}:{})},path==='/me/audience'||adult?'audience':'guardian');
 const assertReviewAuthority=async()=>{
  if(!review&&!adult)return;
  await requireOperator(ctx,actor,true);await guardianAdult(ctx,actor);
  if(adult){if(uuid(adult[1])===actor.accountId)throw new ApiError(403,'guardian_independent_review_required');return;}
  const r=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE id=?',uuid(review![1]));
  if(!r)throw new ApiError(404,'guardian_request_unavailable');
  if(actor.accountId===r.child_account_id||actor.accountId===r.guardian_account_id)throw new ApiError(403,'guardian_independent_review_required');
 };
 await assertReviewAuthority();
 let requestId:string|null=null;
 const receipt=await executeRestrictedOperation(ctx,actor,intent,async()=>{
  if(path==='/me/audience'){
   exact(body,['age_band','policy_version','expected_version','operation_key']);policy(body);
   if(!['under13','13_17','18_plus'].includes(String(body.age_band)))throw new ApiError(400,'audience_input_invalid');
   const old=await row(ctx,actor.accountId);
   if(body.expected_version!==(old?.version??0))throw new ApiError(409,'audience_version_changed');
   if(old&&old.age_band!=='18_plus'&&body.age_band!==old.age_band)throw new ApiError(409,'audience_age_review_required');
   if(old)await revokeAudienceAuthority(ctx,actor.accountId,crypto.randomUUID());
   const version=old?old.version+1:1,status=body.age_band==='under13'?'blocked':body.age_band==='13_17'?'guardian_pending':'eligible';
   await ctx.db.run('INSERT INTO account_audience(account_id,age_band,status,version,declared_at,policy_version) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET age_band=excluded.age_band,status=excluded.status,version=excluded.version,declared_at=excluded.declared_at,policy_version=excluded.policy_version,next_review_at=NULL',actor.accountId,String(body.age_band),status,version,ctx.now(),AUDIENCE_POLICY);
   await audit(ctx,actor.accountId,actor.accountId,'audience.declared',actor.accountId);
   return {account_id:actor.accountId};
  }
  if(path==='/me/guardian-requests'){
   exact(body,['expected_version','policy_version','operation_key']);policy(body);
   const a=await row(ctx,actor.accountId);
   if(!a||a.age_band!=='13_17'||a.policy_version!==AUDIENCE_POLICY)throw new ApiError(403,'guardian_request_ineligible');
   if(body.expected_version!==a.version)throw new ApiError(409,'audience_version_changed');
   if(await ctx.db.one("SELECT id FROM guardian_requests WHERE child_account_id=? AND state IN('pending','under_review','approved') AND expires_at>?",actor.accountId,ctx.now()))throw new ApiError(409,'guardian_request_active');
   for(const old of await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE child_account_id=? AND state IN('pending','under_review','approved') AND expires_at<=?",actor.accountId,ctx.now()))await terminate(ctx,old,'expired',actor.accountId);
   const currentAudience=(await row(ctx,actor.accountId))!;
   requestId=crypto.randomUUID();await ctx.db.run("INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at) VALUES(?,?,'pending',?,?,?,?)",requestId,actor.accountId,currentAudience.version,AUDIENCE_POLICY,ctx.now(),ctx.now()+7*DAY);
   return {request_id:requestId};
  }
  if(adult){
   exact(body,['expected_version','policy_version','evidence_method','evidence_reference','adult_verified','operation_key']);policy(body);evidence(body);await requireOperator(ctx,actor,true);await guardianAdult(ctx,actor);
   const subject=uuid(adult[1]),a=await row(ctx,subject);
   if(subject===actor.accountId)throw new ApiError(403,'guardian_independent_review_required');
   if(!a||a.age_band==='18_plus'||a.version!==body.expected_version||body.adult_verified!==true)throw new ApiError(409,'audience_version_changed');
   for(const old of await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE child_account_id=? AND state IN('pending','under_review','approved')",subject))await retireGuardianRequest(ctx,old,'withdrawn',actor.accountId);
   await revokeAudienceAuthority(ctx,subject,crypto.randomUUID());
   await ctx.db.run("UPDATE account_audience SET age_band='18_plus',status='eligible',policy_version=?,declared_at=?,next_review_at=NULL WHERE account_id=?",AUDIENCE_POLICY,ctx.now(),subject);
   await ctx.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),subject,actor.accountId,String(body.evidence_method),String(body.evidence_reference),ctx.now());
   await audit(ctx,actor.accountId,subject,'audience.adult_review',subject);await assertReviewAuthority();return {account_id:subject};
  }
  requestId=uuid((action??review)![1]);const r=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE id=?',requestId);
  if(!r)throw new ApiError(404,'guardian_request_unavailable');
  if(action?.[2]==='withdraw'){
   exact(body,['expected_revision','operation_key']);await owned(ctx,actor,requestId);
   if(body.expected_revision!==r.revision)throw new ApiError(409,'guardian_revision_changed');
   await terminate(ctx,r,'withdrawn',actor.accountId);return {request_id:requestId};
  }
  policy(body);
  if(r.expires_at<=ctx.now()||r.policy_version!==AUDIENCE_POLICY||body.expected_revision!==r.revision)throw new ApiError(409,'guardian_revision_changed');
  const a=await row(ctx,r.child_account_id);
  if(!a||a.age_band!=='13_17'||a.version!==r.child_audience_version||a.policy_version!==AUDIENCE_POLICY)throw new ApiError(409,'audience_version_changed');
  if(action){
   exact(body,['expected_revision','policy_version','relationship_attested','purposes','operation_key']);await guardianAdult(ctx,actor);
   if(actor.accountId===r.child_account_id)throw new ApiError(403,'guardian_adult_required');
   if(r.state!=='pending'||r.guardian_account_id!==null)throw new ApiError(409,'guardian_revision_changed');
   if(body.relationship_attested!==true||!Array.isArray(body.purposes)||!body.purposes.length||new Set(body.purposes).size!==body.purposes.length||body.purposes.some(p=>!audiencePurposes.includes(p)))throw new ApiError(400,'guardian_purposes_required');
   await ctx.db.run("UPDATE guardian_requests SET guardian_account_id=?,state='under_review',revision=revision+1 WHERE id=?",actor.accountId,requestId);
   for(const purpose of body.purposes as AudiencePurpose[])await ctx.db.run("INSERT INTO guardian_purpose_approvals(id,request_id,child_account_id,guardian_account_id,guardian_audience_version,purpose,policy_version,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'requested',?,?)",crypto.randomUUID(),requestId,r.child_account_id,actor.accountId,(await row(ctx,actor.accountId))!.version,purpose,purposePolicy(ctx,purpose),ctx.now(),r.expires_at);
   await audit(ctx,actor.accountId,r.child_account_id,'guardian.claim',requestId);return {request_id:requestId};
  }
  exact(body,['expected_revision','policy_version','decision','evidence_method','evidence_reference','adult_verified','parental_responsibility_verified','operation_key']);evidence(body);await requireOperator(ctx,actor,true);await guardianAdult(ctx,actor);
  if(actor.accountId===r.child_account_id||actor.accountId===r.guardian_account_id)throw new ApiError(403,'guardian_independent_review_required');
  if(r.state!=='under_review'||!r.guardian_account_id||!['approve','reject'].includes(String(body.decision)))throw new ApiError(409,'guardian_revision_changed');
  if(body.decision==='approve'){
   if(body.adult_verified!==true||body.parental_responsibility_verified!==true)throw new ApiError(400,'guardian_evidence_required');
   const guardian=await row(ctx,r.guardian_account_id);
   if(guardian?.age_band!=='18_plus'||await ctx.db.one('SELECT id FROM guardian_purpose_approvals WHERE request_id=? AND guardian_audience_version<>? LIMIT 1',requestId,guardian.version)||!await audienceContext(ctx,r.guardian_account_id,'face_authentication')||!await ctx.db.one("SELECT id FROM face_profiles WHERE account_id=? AND status='active' AND auth_enabled=1",r.guardian_account_id))throw new ApiError(403,'guardian_adult_required');
   const expires=ctx.now()+365*DAY;
   await ctx.db.run("UPDATE guardian_requests SET state='approved',revision=revision+1,reviewed_by=?,reviewed_at=?,evidence_method=?,evidence_reference=?,expires_at=? WHERE id=?",actor.accountId,ctx.now(),String(body.evidence_method),String(body.evidence_reference),expires,requestId);
   await ctx.db.run("UPDATE guardian_purpose_approvals SET status='approved',version=version+1,expires_at=? WHERE request_id=? AND status='requested'",expires,requestId);
   await ctx.db.run("UPDATE account_audience SET status='eligible',next_review_at=? WHERE account_id=?",expires,r.child_account_id);
   await audit(ctx,actor.accountId,r.child_account_id,'guardian.approved',requestId);
  }else{
   await ctx.db.run('UPDATE guardian_requests SET reviewed_by=?,reviewed_at=?,evidence_method=?,evidence_reference=? WHERE id=?',actor.accountId,ctx.now(),String(body.evidence_method),String(body.evidence_reference),requestId);
   await terminate(ctx,r,'rejected',actor.accountId);
  }
  await assertReviewAuthority();
  return {request_id:requestId};
 });
 // Replays report current authority, never a stale stored approval/capability.
 return ctx.db.transaction(async()=>{
  await assertPrivacyActor(actor,ctx);
  await assertReviewAuthority();
  if(path==='/me/audience'||adult){const projection=await audienceProjection(ctx,String(receipt.account_id));await assertReviewAuthority();return ok(projection);}
  const r=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE id=?',String(receipt.request_id));
  if(!r)throw new ApiError(404,'guardian_request_unavailable');
  const projection={guardian_request:await requestProjection(ctx,r),...(path==='/me/guardian-requests'?{audience:await audienceProjection(ctx,actor.accountId)}:{})};
  await assertReviewAuthority();
  return ok(projection,path==='/me/guardian-requests'?201:200);
 });
}
/** Expiration is effective in guards immediately; maintenance records terminal
 * state, invalidates old authority and keeps failed cleanup obligations durable. */
export async function maintainAudience(ctx: AppContext):Promise<void>{
 await ctx.db.transaction(async()=>{
  // Select due/invalid rows before LIMIT. A long-lived valid approval must
  // never starve expiration of a newer request in a bounded maintenance pass.
  for(const r of await ctx.db.all<Guardian>(`SELECT r.* FROM guardian_requests r WHERE r.state IN('pending','under_review','approved')
    AND (r.expires_at<=? OR r.policy_version<>? OR NOT EXISTS(SELECT 1 FROM account_audience a WHERE a.account_id=r.child_account_id AND a.age_band='13_17' AND a.version=r.child_audience_version AND a.policy_version=?)
    OR (r.state='approved' AND NOT EXISTS(SELECT 1 FROM guardian_purpose_approvals p
      JOIN account_audience g ON g.account_id=p.guardian_account_id AND g.age_band='18_plus' AND g.status='eligible' AND g.policy_version=? AND g.version=p.guardian_audience_version
      JOIN accounts ga ON ga.id=g.account_id AND ga.identity_state='registered_face' AND ga.disabled_at IS NULL
      JOIN face_profiles fp ON fp.account_id=ga.id AND fp.status='active' AND fp.auth_enabled=1
      JOIN consents c ON c.id=fp.auth_consent_id AND c.account_id=ga.id AND c.status='granted' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?) AND c.policy_version=?
      WHERE p.request_id=r.id AND p.status='approved' AND p.revoked_at IS NULL AND p.expires_at>? AND p.policy_version=CASE WHEN p.purpose='face_authentication' THEN ? ELSE ? END
      AND NOT EXISTS(SELECT 1 FROM privacy_requests d WHERE d.subject_id=ga.id AND d.request_type='delete' AND d.status IN('pending_approval','approved','queued','processing','failed')))))
    ORDER BY r.created_at,r.id LIMIT 100`,ctx.now(),AUDIENCE_POLICY,AUDIENCE_POLICY,AUDIENCE_POLICY,ctx.now(),ctx.env.FACE_AUTH_POLICY_VERSION??'',ctx.now(),purposePolicy(ctx,'face_authentication'),purposePolicy(ctx,'photo_matching'))){
   const a=await row(ctx,r.child_account_id);
   const invalid=r.expires_at<=ctx.now()||r.policy_version!==AUDIENCE_POLICY||!a||a.age_band!=='13_17'||a.version!==r.child_audience_version||a.policy_version!==AUDIENCE_POLICY||r.state==='approved'&&!await audienceContext(ctx,r.child_account_id,'face_authentication')&&!await audienceContext(ctx,r.child_account_id,'photo_matching')&&!await audienceContext(ctx,r.child_account_id,'photo_processing');
   if(invalid)await terminate(ctx,r,'expired',r.reviewed_by??r.child_account_id);
  }
  // Terminal metadata is purged by retention together with its linked operation
  // copies; removing it here would lose the positive receipt-retirement binding.
 });
}
export async function audiencePrivacyRows(ctx:AppContext,subject:string):Promise<Record<string,unknown>>{
 return {audience_declaration:await ctx.db.all('SELECT age_band,status,version,declared_at,policy_version,next_review_at FROM account_audience WHERE account_id=?',subject),guardian_child_requests:await ctx.db.all('SELECT id,state,revision,policy_version,created_at,expires_at,reviewed_at,terminated_at FROM guardian_requests WHERE child_account_id=? ORDER BY id LIMIT 25001',subject),guardian_given_approvals:await ctx.db.all('SELECT id,purpose,policy_version,status,created_at,expires_at,revoked_at FROM guardian_purpose_approvals WHERE guardian_account_id=? ORDER BY id LIMIT 25001',subject)};
}
export async function eraseAudienceSubject(ctx:AppContext,subject:string):Promise<void>{
 for(const r of await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE guardian_account_id=? AND state IN('pending','under_review','approved')",subject))await terminate(ctx,r,'withdrawn',subject);
 for(const r of await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE child_account_id=? AND state IN('pending','under_review','approved')",subject))await terminate(ctx,r,'withdrawn',subject);
 // A minimized decision/withdrawal receipt is retained for 365 days. Delete the
 // age declaration at erasure, not foreign guardian/reviewer private evidence.
 await ctx.db.run('DELETE FROM account_audience WHERE account_id=?',subject);
}
