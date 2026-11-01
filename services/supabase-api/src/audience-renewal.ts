import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { assertPrivacyActor } from './auth.ts';
import { verifyKey, type Device, type Profile, type Challenge } from './face-auth.ts';
import { executeAudienceDeviceOperation, executeRestrictedOperation, prepareOperation } from './operations.ts';
import { restoreOperationID, type RestoreTransactionScope } from './restore-transaction.ts';
import { AUDIENCE_POLICY, AUDIENCE_RECOVERY_MS, audienceDeadlineSQL, audienceBandSQL, decisionInput, decisionProjection, type AudienceDecision } from './audience-decision.ts';
import { audienceContext, audienceProjection, audienceRow, storeAudienceDecision, prepareTerminations, terminate, retireGuardianRequest, type Guardian, type AudiencePurpose } from './audience.ts';

const DEVICE_PROTOCOL = 'lovelies-audience-device-v1';
type Retirement = {
 account_id:string; audience_version:number; deadline:number; retired_at:number; recover_until:number;
 profile_id:string|null;profile_revision:string|null;profile_epoch:number|null;auth_consent_id:string|null;auth_policy:string|null;
 template_key:string|null;template_digest:string|null;cleanup_id:string|null;removal_verified_at:number|null;
 enrollment_binding:string|null;enrollment_consent_id:string|null;enrollment_rebound_consent_id:string|null;enrollment_expires_at:number|null;disposition:'retained'|'renewed'|'removed';
};
type DeviceOwner = {id:string;auth_epoch:number;identity_state:string;disabled_at:number|null};
type DeviceBinding = {device:Device;owner:DeviceOwner};
type Renewal = {operation_key:string;from_version:number;to_version:number;next_step:'face_login'|'profile_recovery'|'guardian_review';guardian_request_id?:string};
const unavailable = ():never => {throw new ApiError(404,'audience_device_unavailable');};
function nonce(input:Record<string,unknown>,ctx:AppContext):void {
 uuid(input.request_nonce);
 if(!Number.isSafeInteger(input.request_expires_at)||(input.request_expires_at as number)<=ctx.now()||(input.request_expires_at as number)>ctx.now()+60000)
  throw new ApiError(401,'audience_request_expired');
}
function authConsent(input:Record<string,unknown>,ctx:AppContext,currentPolicy=true):void {
 const c=input.consent as Record<string,unknown>;
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='granted,policy_version,purpose'||
  c.purpose!=='face_authentication'||c.granted!==true||typeof c.policy_version!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(c.policy_version)||currentPolicy&&c.policy_version!==ctx.env.FACE_AUTH_POLICY_VERSION)
  throw new ApiError(400,'explicit_auth_consent_required');
}
async function noDeletion(ctx:AppContext,account:string):Promise<void> {
 if(await ctx.db.one("SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND status IN('pending_approval','approved','queued','processing','failed') LIMIT 1",account))
  throw new ApiError(409,'audience_deletion_pending');
}
async function binding(ctx:AppContext,input:Record<string,unknown>,expected?:DeviceBinding):Promise<DeviceBinding> {
 nonce(input,ctx);
 const account=uuid(input.account_id),id=uuid(input.device_id);
 if(typeof input.face_handle!=='string'||!/^lfh_[A-Za-z0-9_-]{43}$/.test(input.face_handle))return unavailable();
 const device=await ctx.db.one<Device>('SELECT id,account_id,public_jwk,revision,status,face_handle FROM auth_devices WHERE id=? AND account_id=?',id,account);
 const owner=await ctx.db.one<DeviceOwner>('SELECT id,auth_epoch,identity_state,disabled_at FROM accounts WHERE id=?',account);
 if(!device||device.status!=='active'||device.face_handle!==await digest(input.face_handle)||!owner||owner.disabled_at!==null||owner.identity_state!=='registered_face')return unavailable();
 const selected={device,owner};
 if(expected&&stable(selected)!==stable(expected))return unavailable();
 await noDeletion(ctx,account);nonce(input,ctx);return selected;
}
async function referenceState(ctx:AppContext,account:string):Promise<'face_login'|'profile_recovery'> {
 const current=await ctx.db.one(`SELECT p.id FROM face_profiles p JOIN consents c ON c.id=p.auth_consent_id
  WHERE p.account_id=? AND p.status='active' AND p.auth_enabled=1 AND c.account_id=p.account_id
   AND c.purpose='face_authentication' AND c.status='granted' AND c.revoked_at IS NULL
   AND (c.expires_at IS NULL OR c.expires_at>?) AND c.policy_version=?
   AND (c.profile_revision IS NULL OR c.profile_revision=p.revision)`,account,ctx.now(),ctx.env.FACE_AUTH_POLICY_VERSION??'');
 return current?'face_login':'profile_recovery';
}
async function statusFields(ctx:AppContext,account:string):Promise<Record<string,unknown>> {
 const a=await audienceRow(ctx,account),capability=await audienceContext(ctx,account,'face_authentication');
 const retired=a&&await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND audience_version=?',account,a.version);
 const guardian=a?.age_band==='13_17'?await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE child_account_id=? ORDER BY created_at DESC,id DESC LIMIT 1',account):null;
 const dueAdult=!!a&&a.age_band==='18_plus'&&a.policy_version===AUDIENCE_POLICY&&a.next_review_at<=ctx.now()&&(a.status==='eligible'||!!retired);
 let guardianAvailable=false;
 if(a?.age_band==='13_17'&&a.policy_version===AUDIENCE_POLICY){try{guardianAvailable=(await minorReviewDeadline(ctx,a))<=ctx.now();}catch(error){if(!(error instanceof ApiError)||!['guardian_review_not_due','guardian_review_pending'].includes(error.code))throw error;}}
 return {audience:decisionProjection(a,ctx.now(),!!capability),authority_expires_at:await audienceAuthorityExpiry(ctx,account),renewal_available:dueAdult,guardian_review_available:guardianAvailable,
  next_step:dueAdult?'audience_review':a?.age_band==='13_17'&&!capability?'guardian_review':capability?await referenceState(ctx,account):'profile_recovery',
  guardian_request:guardian?{id:guardian.id,state:guardian.expires_at<=ctx.now()&&['pending','under_review','approved'].includes(guardian.state)?'expired':guardian.state,
   revision:guardian.revision,policy_version:guardian.policy_version,expires_at:new Date(guardian.expires_at).toISOString()}:null};
}
/** The challenge and media consumers receive the earliest applicable deadline,
 * including the selected guardian's annual review and authentication consent. */
export async function audienceReferenceDeadline(ctx:AppContext,account:string,purpose:AudiencePurpose='face_authentication'):Promise<number> {
 const a=await audienceRow(ctx,account),authority=await audienceContext(ctx,account,purpose);
 if(!a||!authority)throw new ApiError(403,'audience_review_required');
 let end=a.next_review_at;
 if(a.age_band==='13_17'){
  const selected=JSON.parse(authority);
  const p=await ctx.db.one<{approval:number;request:number;guardian:number;consent:number|null}>(`SELECT p.expires_at approval,r.expires_at request,
   ${audienceDeadlineSQL('g')} guardian,c.expires_at consent FROM guardian_purpose_approvals p
   JOIN guardian_requests r ON r.id=p.request_id JOIN account_audience g ON g.account_id=p.guardian_account_id
   JOIN face_profiles fp ON fp.account_id=g.account_id JOIN consents c ON c.id=fp.auth_consent_id WHERE p.id=? AND r.id=?`,selected.approval,selected.request);
  if(!p)throw new ApiError(403,'guardian_approval_required');end=Math.min(end,p.approval,p.request,p.guardian,p.consent??end);
 }
 const profile=await ctx.db.one<{auth_consent_id:string|null;consent_id:string|null}>('SELECT auth_consent_id,consent_id FROM face_profiles WHERE account_id=?',account);
 const referenced=purpose==='face_authentication'?profile?.auth_consent_id:purpose==='photo_matching'?profile?.consent_id:undefined;
 // A pending lifecycle creates its own new consent. It cannot replace the
 // expiry of the consent still referenced by the active profile/session.
 const own=profile&&purpose!=='photo_processing'
  ?referenced?await ctx.db.one<{expires_at:number|null}>("SELECT expires_at FROM consents WHERE id=? AND account_id=? AND purpose=? AND status='granted' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",referenced,account,purpose,ctx.now()):null
  :await ctx.db.one<{expires_at:number|null}>("SELECT min(expires_at) expires_at FROM consents WHERE account_id=? AND purpose=? AND status='granted' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",account,purpose,ctx.now());
 if(own?.expires_at!==null&&own?.expires_at!==undefined)end=Math.min(end,own.expires_at);
 if(end<=ctx.now())throw new ApiError(403,'audience_review_required');return end;
}
/** Separate from declaration metadata: clients discard displayed private data at
 * the earliest current purpose/guardian authority boundary. */
export async function audienceAuthorityExpiry(ctx:AppContext,account:string):Promise<string|null> {
 const ends:number[]=[];
 for(const purpose of ['face_authentication','photo_matching','photo_processing'] as const)
  if(await audienceContext(ctx,account,purpose))ends.push(await audienceReferenceDeadline(ctx,account,purpose));
 return ends.length?new Date(Math.min(...ends)).toISOString():null;
}
async function retireDependants(ctx:AppContext,account:string,restore:RestoreTransactionScope):Promise<void> {
 const requests=await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE guardian_account_id=? AND state IN('pending','under_review','approved') ORDER BY created_at,id",account);
 const group=await prepareTerminations(ctx,restore,requests);
 for(const plan of group.plans)await terminate(ctx,plan.request,'expired',account,plan.controlsCurrent);
}
/** Preserve a positive cleanup completion route when an independently retired
 * guardian episode invalidates a registered child before its annual deadline.
 * This row never permits reference reuse or adult declaration renewal. */
export async function recordAudienceRestrictionReference(ctx:AppContext,a:AudienceDecision,previous:Profile):Promise<void> {
 const p=await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',a.account_id);
 const retirement=await ctx.db.one<{cleanup_id:string}>('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=? AND profile_id=? AND profile_revision=? AND template_key=? ORDER BY cleanup_id LIMIT 1',a.account_id,previous.id,previous.revision,previous.template_key);
 if(!p||p.status!=='revoked'||p.id!==previous.id||!retirement)throw new ApiError(409,'audience_authority_changed');
 const consent=p.auth_consent_id?await ctx.db.one<{policy_version:string}>('SELECT policy_version FROM consents WHERE id=? AND account_id=?',p.auth_consent_id,a.account_id):null;
 const now=ctx.now();
 await ctx.db.run(`INSERT INTO audience_review_retirements(account_id,audience_version,deadline,retired_at,recover_until,profile_id,profile_revision,profile_epoch,auth_consent_id,auth_policy,template_key,template_digest,cleanup_id,disposition)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'removed') ON CONFLICT(account_id,audience_version) DO UPDATE SET disposition='removed',profile_epoch=excluded.profile_epoch`,
  a.account_id,a.version,now,now,now,p.id,p.revision,p.auth_epoch,p.auth_consent_id,p.auth_consent_id?(consent?.policy_version??'unavailable'):null,p.template_key,p.template_digest,retirement.cleanup_id);
}
async function minorReviewDeadline(ctx:AppContext,a:AudienceDecision):Promise<number> {
 if(a.next_review_at<=ctx.now())return a.next_review_at;
 for(const purpose of ['face_authentication','photo_matching','photo_processing'] as const)
  if(await audienceContext(ctx,a.account_id,purpose))throw new ApiError(409,'guardian_review_not_due');
 const r=await ctx.db.one<Guardian>('SELECT * FROM guardian_requests WHERE child_account_id=? ORDER BY created_at DESC,id DESC LIMIT 1',a.account_id);
 if(r&&['pending','under_review'].includes(r.state)&&r.expires_at>ctx.now())throw new ApiError(409,'guardian_review_pending');
 const deadlines=[a.next_review_at,r?.expires_at??Infinity,r?.terminated_at??Infinity];
 if(r?.guardian_account_id){
  const g=await audienceRow(ctx,r.guardian_account_id);if(g)deadlines.push(g.next_review_at);
  const c=await ctx.db.one<{expires_at:number|null;revoked_at:number|null}>(`SELECT c.expires_at,c.revoked_at FROM face_profiles p JOIN consents c ON c.id=p.auth_consent_id WHERE p.account_id=?`,r.guardian_account_id);
  if(c)deadlines.push(c.expires_at??Infinity,c.revoked_at??Infinity);
  const approvals=await ctx.db.all<{expires_at:number;revoked_at:number|null}>('SELECT expires_at,revoked_at FROM guardian_purpose_approvals WHERE request_id=?',r.id);
  for(const p of approvals)deadlines.push(p.expires_at,p.revoked_at??Infinity);
 }
 return Math.max(a.declared_at,Math.min(ctx.now(),...deadlines));
}
type PendingEnrollment=Record<string,unknown>&{account_id:string;enrollment_key:string;device_id:string;device_revision:string;public_key_digest:string;handle_hash:string;consent_id:string;policy_version:string;auth_epoch:number;challenge_id:string;expires_at:number;revoked_at:number|null;completed_profile_id:string|null};
async function pendingEnrollmentSnapshot(ctx:AppContext,account:string,retiredAt?:number,rebound?:string):Promise<{intent:PendingEnrollment;binding:string}|null>{
 const owner=await ctx.db.one<DeviceOwner>('SELECT id,auth_epoch,identity_state,disabled_at FROM accounts WHERE id=?',account);
 if(!owner||owner.disabled_at!==null||owner.identity_state!=='anonymous'||await ctx.db.one('SELECT id FROM face_profiles WHERE account_id=?',account))return null;
 const rows=await ctx.db.all<PendingEnrollment>('SELECT * FROM face_enrollment_intents WHERE account_id=? AND completed_profile_id IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY enrollment_key LIMIT 2',account,ctx.now());
 if(rows.length!==1)return null;
 const intent=rows[0],device=await ctx.db.one<Device>('SELECT * FROM auth_devices WHERE id=? AND account_id=?',intent.device_id,account);
 const c=await ctx.db.one<Record<string,unknown>&{id:string;status:string;revoked_at:number|null;expires_at:number|null}>('SELECT * FROM consents WHERE id=? AND account_id=? AND purpose=? AND policy_version=?',rebound??intent.consent_id,account,'face_authentication',ctx.env.FACE_AUTH_POLICY_VERSION??'');
 const challenge=await ctx.db.one<Challenge>('SELECT * FROM auth_challenges WHERE id=?',intent.challenge_id);
 if(intent.policy_version!==ctx.env.FACE_AUTH_POLICY_VERSION||intent.auth_epoch!==owner.auth_epoch||!device||device.status!=='pending'||device.revision!==intent.device_revision||device.face_handle!==intent.handle_hash||await digest(device.public_jwk)!==intent.public_key_digest||
  !c||(retiredAt===undefined?(c.status!=='granted'||c.revoked_at!==null):(c.status!=='revoked'||c.revoked_at!==retiredAt))||c.expires_at!==null&&c.expires_at<=ctx.now()||
  !challenge||challenge.account_id!==account||challenge.device_id!==intent.device_id||challenge.device_revision!==intent.device_revision||challenge.consent_id!==(rebound??intent.consent_id)||challenge.profile_id!==null||challenge.purpose!=='registration'||challenge.auth_epoch!==owner.auth_epoch||challenge.required_captures!==3)return null;
 const {status:_status,revoked_at:_revoked,...consentMetadata}=c;
 return {intent,binding:await digest(stable({intent:rebound?{...intent,consent_id:rebound}:intent,device,owner,consent:consentMetadata}))};
}
/** An expired original challenge stays cancelled and keeps its old consent.
 * Only this exact annual-review consent replacement permits metadata recovery;
 * signed resume must still create a fresh three-capture successor. */
export async function reviewEnrollmentConsentMatches(ctx:AppContext,account:string,currentConsent:string,challenge:Challenge):Promise<boolean>{
 if(challenge.status!=='cancelled'||challenge.used_at===null)return false;
 const r=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND enrollment_consent_id=? AND enrollment_rebound_consent_id=?',account,challenge.consent_id,currentConsent);
 if(!r||!r.enrollment_binding||r.enrollment_expires_at!<=ctx.now())return false;
 const snapshot=await pendingEnrollmentSnapshot(ctx,account,r.retired_at,r.enrollment_consent_id!);
 return !!snapshot&&snapshot.intent.consent_id===currentConsent&&snapshot.binding===r.enrollment_binding;
}
async function renewPendingEnrollment(ctx:AppContext,account:string,version:number,limit:{value:number}):Promise<boolean>{
 const r=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND audience_version=?',account,version);
 if(!r?.enrollment_binding||r.enrollment_rebound_consent_id!==null||r.enrollment_expires_at!<=ctx.now())return false;
 const snapshot=await pendingEnrollmentSnapshot(ctx,account,r.retired_at);
 if(!snapshot||snapshot.binding!==r.enrollment_binding||snapshot.intent.consent_id!==r.enrollment_consent_id)return false;
 if(await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1",account))throw new ApiError(409,'enrollment_in_flight');
 // No old capture or reference is adopted. This metadata-only consent bridge is
 // bounded by the original, unchanged enrollment-control expiry; resume always
 // takes fresh captures. Existing cleanup of the cancelled challenge continues.
 limit.value=Math.min(limit.value,r.enrollment_expires_at!);
 const id=crypto.randomUUID();
 await ctx.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'face_authentication',?,'granted',?)",id,account,ctx.env.FACE_AUTH_POLICY_VERSION!,ctx.now());
 await ctx.db.run('UPDATE face_enrollment_intents SET consent_id=? WHERE account_id=? AND enrollment_key=? AND consent_id=?',id,account,snapshot.intent.enrollment_key,r.enrollment_consent_id!);
 await ctx.db.run("UPDATE audience_review_retirements SET disposition='renewed',enrollment_rebound_consent_id=? WHERE account_id=? AND audience_version=?",id,account,version);
 return true;
}
/** Annual expiry is a denial operation. The reference may be held solely for
 * exact-account explicit review recovery for at most 24h; it is unusable for
 * authentication/matching in this state. No existing consent is regranted. */
export async function retireAudienceReview(ctx:AppContext,a:AudienceDecision,restore:RestoreTransactionScope,effectiveDeadline=a.next_review_at):Promise<Retirement> {
 const previous=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND audience_version=?',a.account_id,a.version);
 if(previous)return previous;
 if(effectiveDeadline>ctx.now()||effectiveDeadline>a.next_review_at||a.policy_version!==AUDIENCE_POLICY||a.age_band==='under13')throw new ApiError(409,'audience_review_not_due');
 const current=await audienceRow(ctx,a.account_id);if(stable(current)!==stable(a))throw new ApiError(409,'audience_authority_changed');
 const now=ctx.now(),profile=await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',a.account_id);
 const enrollment=profile?null:await pendingEnrollmentSnapshot(ctx,a.account_id);
 const consents=await ctx.db.all<{id:string;purpose:string}>("SELECT id,purpose FROM consents WHERE account_id=? AND purpose IN('face_authentication','photo_matching','photo_processing') AND status='granted' ORDER BY id",a.account_id);
 for(const c of consents)await restore.restrict('consent-withdrawn',{account_id:a.account_id,consent_id:c.id,purpose:c.purpose});
 if(profile?.status==='active')await restore.restrict('profile-retired',{account_id:a.account_id,profile_id:profile.id,profile_revision:profile.revision});
 const requests=await ctx.db.all<{id:string;sender_id:string;recipient_id:string}>("SELECT id,sender_id,recipient_id FROM sharing_requests WHERE (sender_id=? OR recipient_id=?) AND status IN('requested','accepted') ORDER BY id",a.account_id,a.account_id);
 for(const r of requests)await restore.restrict('sharing-request-retired',{sender_id:r.sender_id,recipient_id:r.recipient_id,request_id:r.id});
 await retireDependants(ctx,a.account_id,restore);
 const c=profile?.auth_consent_id?await ctx.db.one<{policy_version:string;expires_at:number|null;status:string;revoked_at:number|null;account_id:string;purpose:string}>('SELECT policy_version,expires_at,status,revoked_at,account_id,purpose FROM consents WHERE id=?',profile.auth_consent_id):null;
 const existingCleanup=profile&&await ctx.db.one('SELECT id FROM cleanup_intents WHERE subject_id=? AND bucket=? AND object_key=? LIMIT 1',a.account_id,'PHOTOS',profile.template_key);
 const recoverUntil=Math.max(effectiveDeadline,Math.min(effectiveDeadline+AUDIENCE_RECOVERY_MS,c?.expires_at??effectiveDeadline+AUDIENCE_RECOVERY_MS));
 const usable=!!profile&&profile.status==='active'&&profile.auth_enabled===1&&!!c&&c.account_id===a.account_id&&c.purpose==='face_authentication'&&c.status==='granted'&&c.revoked_at===null&&
  (c.expires_at===null||c.expires_at>now)&&c.policy_version===ctx.env.FACE_AUTH_POLICY_VERSION&&!existingCleanup&&now<recoverUntil;
 // A missing/independently retired reference is not recreated. Its existing
 // exact cleanup obligation remains available to the normal lifecycle path.
 let cleanup:string|null=null;
 if(profile){
  cleanup=(await ctx.db.one<{cleanup_id:string}>('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=? AND template_key=? ORDER BY cleanup_id LIMIT 1',a.account_id,profile.template_key))?.cleanup_id??crypto.randomUUID();
  if(!await ctx.db.one('SELECT id FROM cleanup_intents WHERE id=?',cleanup)){
   await ctx.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",cleanup,a.account_id,profile.template_key,now);
   await ctx.db.run('INSERT INTO face_profile_retirements(cleanup_id,account_id,operation_key,profile_id,profile_revision,template_key,template_digest) VALUES(?,?,?,?,?,?,?)',cleanup,a.account_id,'audience:review:'+a.version,profile.id,profile.revision,profile.template_key,profile.template_digest);
  }
 }
 await ctx.db.run("UPDATE consents SET status='revoked',revoked_at=coalesce(revoked_at,?) WHERE account_id=? AND purpose IN('face_authentication','photo_matching','photo_processing') AND status='granted'",now,a.account_id);
 await ctx.db.run("UPDATE face_profiles SET status='revoked',auth_enabled=0,auth_epoch=auth_epoch+1,consent_id=NULL WHERE account_id=?",a.account_id);
 await ctx.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?",a.account_id);
 await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE account_id=? AND used_at IS NULL",now,a.account_id);
 await ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND state='pending'",a.account_id);
 await ctx.db.run('UPDATE face_recovery_keys SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?',now,a.account_id);
 await ctx.db.run("UPDATE processing_attempts SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_id=? AND status<>'completed'",a.account_id);
 await ctx.db.run("UPDATE photo_job_outbox SET status='cancelled' WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)",a.account_id);
 await ctx.db.run("UPDATE candidates SET status='invalidated',version=? WHERE owner_id=? OR recipient_id=?",crypto.randomUUID(),a.account_id,a.account_id);
 await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE owner_id=? OR recipient_id=?',now,a.account_id,a.account_id);
 await ctx.db.run("UPDATE sharing_requests SET status='revoked',updated_at=? WHERE (sender_id=? OR recipient_id=?) AND status IN('requested','accepted')",now,a.account_id,a.account_id);
 await ctx.db.run('DELETE FROM media_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)',a.account_id,a.account_id);
 await ctx.db.run('DELETE FROM download_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)',a.account_id,a.account_id);
 await ctx.db.run('INSERT INTO face_profile_states(account_id,version,matching_paused) VALUES(?,1,1) ON CONFLICT(account_id) DO UPDATE SET matching_paused=1',a.account_id);
 await ctx.db.run(`INSERT INTO audience_review_retirements(account_id,audience_version,deadline,retired_at,recover_until,profile_id,profile_revision,profile_epoch,auth_consent_id,auth_policy,template_key,template_digest,cleanup_id,disposition)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,a.account_id,a.version,effectiveDeadline,now,recoverUntil,profile?.id??null,profile?.revision??null,profile?profile.auth_epoch+1:null,
  profile?.auth_consent_id??null,profile?.auth_consent_id?(c?.policy_version??'unavailable'):null,profile?.template_key??null,profile?.template_digest??null,cleanup,usable?'retained':'removed');
 if(enrollment)await ctx.db.run('UPDATE audience_review_retirements SET enrollment_binding=?,enrollment_consent_id=?,enrollment_expires_at=? WHERE account_id=? AND audience_version=?',enrollment.binding,enrollment.intent.consent_id,enrollment.intent.expires_at,a.account_id,a.version);
 return (await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND audience_version=?',a.account_id,a.version))!;
}
/** Used by the existing cleanup guard before its first external delete. Before
 * the deadline deletion is forbidden; after it reference re-adoption is forbidden.
 * This disjoint time boundary avoids an in-flight delete/re-adoption race. */
export async function assertAudienceCleanupReady(ctx:AppContext,cleanupID:string):Promise<void> {
 const r=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE cleanup_id=?',cleanupID);
 if(r?.disposition==='retained'&&r.recover_until>ctx.now())throw new ApiError(409,'audience_reference_recovery_window');
}
export async function recoverableReviewReference(ctx:AppContext,account:string,profile:Profile):Promise<Retirement|null> {
 if(await ctx.db.one(`SELECT 1 WHERE EXISTS(SELECT 1 FROM retention_settings WHERE id='default' AND legal_hold=1)
  OR EXISTS(SELECT 1 FROM moderation_holds WHERE active=1 AND subject_id=?)
  OR EXISTS(SELECT 1 FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled'))`,account,account))return null;
 const r=await ctx.db.one<Retirement>("SELECT * FROM audience_review_retirements WHERE account_id=? AND profile_id=? AND profile_revision=? AND disposition='retained' ORDER BY audience_version DESC LIMIT 1",account,profile.id,profile.revision);
 if(!r||ctx.now()>=r.recover_until||profile.status!=='revoked'||profile.auth_enabled!==0||profile.auth_epoch!==r.profile_epoch||
  profile.auth_consent_id!==r.auth_consent_id||profile.template_key!==r.template_key||profile.template_digest!==r.template_digest)return null;
 const cleanup=await ctx.db.one<{status:string;attempts:number;request_id:string|null;object_key:string;subject_id:string}>('SELECT status,attempts,request_id,object_key,subject_id FROM cleanup_intents WHERE id=?',r.cleanup_id!);
 const consent=await ctx.db.one<{status:string;revoked_at:number|null}>('SELECT status,revoked_at FROM consents WHERE id=? AND account_id=?',r.auth_consent_id!,account);
 if(!cleanup||cleanup.status!=='pending'||cleanup.attempts!==0||cleanup.request_id!==null||cleanup.object_key!==r.template_key||cleanup.subject_id!==account||
   consent?.status!=='revoked'||consent.revoked_at!==r.retired_at||await ctx.db.one('SELECT id FROM cleanup_intents WHERE subject_id=? AND bucket=? AND object_key=? AND id<>? LIMIT 1',account,'PHOTOS',profile.template_key,r.cleanup_id!)||
   await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND bucket='PHOTOS' AND object_key=? AND status='pending' LIMIT 1",account,profile.template_key))return null;
 return r;
}
export async function completeReviewReference(ctx:AppContext,r:Retirement):Promise<void> {
 if(ctx.now()>=r.recover_until)throw new ApiError(409,'audience_reference_recovery_expired');
 // This exact intent could never dispatch during the retained window. Removing
 // its schedule is not a claim that an object was deleted. All other intents stay.
 await ctx.db.run('DELETE FROM face_profile_retirements WHERE cleanup_id=? AND account_id=?',r.cleanup_id!,r.account_id);
 await ctx.db.run("DELETE FROM cleanup_intents WHERE id=? AND subject_id=? AND status='pending' AND attempts=0 AND request_id IS NULL",r.cleanup_id!,r.account_id);
 if(await ctx.db.one('SELECT id FROM cleanup_intents WHERE id=?',r.cleanup_id!))throw new ApiError(409,'audience_cleanup_changed');
 await ctx.db.run("UPDATE audience_review_retirements SET disposition='renewed',profile_id=NULL,profile_revision=NULL,profile_epoch=NULL,auth_consent_id=NULL,auth_policy=NULL,template_key=NULL,template_digest=NULL,cleanup_id=NULL WHERE account_id=? AND audience_version=?",r.account_id,r.audience_version);
}
export async function completedReviewRemoval(ctx:AppContext,account:string):Promise<boolean> {
 if(await ctx.db.one('SELECT id FROM face_profiles WHERE account_id=?',account))return false;
 const r=await ctx.db.one<Retirement>("SELECT * FROM audience_review_retirements WHERE account_id=? AND (profile_id IS NOT NULL OR removal_verified_at IS NOT NULL) ORDER BY audience_version DESC LIMIT 1",account);
 return !!r&&r.profile_id===null&&r.removal_verified_at!==null&&r.removal_verified_at<=ctx.now();
}
export async function audienceReviewRemovalState(ctx:AppContext,account:string):Promise<string> {
 if(await completedReviewRemoval(ctx,account))return 'completed';
 const r=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND cleanup_id IS NOT NULL ORDER BY audience_version DESC LIMIT 1',account);
 if(!r)return 'none';
 if(await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1',account))return 'blocked';
 const c=await ctx.db.one<{status:string}>('SELECT status FROM cleanup_intents WHERE id=? AND subject_id=?',r.cleanup_id!,account);
 return c?.status==='failed'?'failed':'pending';
}
export async function finishReviewCleanup(ctx:AppContext):Promise<void> {
 const enrollmentRows=await ctx.db.all<Retirement>('SELECT * FROM audience_review_retirements WHERE enrollment_binding IS NOT NULL ORDER BY retired_at,account_id LIMIT 100');
 for(const r of enrollmentRows){
  const i=await ctx.db.one<PendingEnrollment>('SELECT * FROM face_enrollment_intents WHERE account_id=? AND consent_id=?',r.account_id,r.enrollment_rebound_consent_id??r.enrollment_consent_id!);
  if(!i)continue; // Absent metadata is not evidence that the original intent settled.
  const challenge=await ctx.db.one<Challenge>('SELECT * FROM auth_challenges WHERE id=?',i.challenge_id);
  const complete=i.revoked_at!==null||i.expires_at<=ctx.now()||i.completed_profile_id!==null||r.enrollment_rebound_consent_id!==null&&challenge?.consent_id===r.enrollment_rebound_consent_id;
  if(!complete||await ctx.db.one(`SELECT 1 WHERE EXISTS(SELECT 1 FROM retention_settings WHERE id='default' AND legal_hold=1)
    OR EXISTS(SELECT 1 FROM moderation_holds WHERE active=1 AND subject_id=?)
    OR EXISTS(SELECT 1 FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled'))
    OR EXISTS(SELECT 1 FROM media_write_intents WHERE account_id=? AND status='pending')`,r.account_id,r.account_id,r.account_id))continue;
  await ctx.db.run('UPDATE audience_review_retirements SET enrollment_binding=NULL,enrollment_consent_id=NULL,enrollment_rebound_consent_id=NULL,enrollment_expires_at=NULL WHERE account_id=? AND audience_version=?',r.account_id,r.audience_version);
 }
 const rows=await ctx.db.all<Retirement>(`SELECT r.* FROM audience_review_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id
  WHERE c.status='verified' ORDER BY r.deadline,r.account_id LIMIT 100`);
 for(const r of rows){
  if(await ctx.db.one(`SELECT 1 WHERE EXISTS(SELECT 1 FROM retention_settings WHERE id='default' AND legal_hold=1)
   OR EXISTS(SELECT 1 FROM moderation_holds WHERE active=1 AND subject_id=?)
   OR EXISTS(SELECT 1 FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND legal_hold=1 AND status NOT IN('completed','rejected','cancelled'))
   OR EXISTS(SELECT 1 FROM media_write_intents WHERE account_id=? AND bucket='PHOTOS' AND object_key=? AND status='pending')
   OR EXISTS(SELECT 1 FROM cleanup_intents WHERE subject_id=? AND bucket='PHOTOS' AND object_key=? AND status<>'verified')`,r.account_id,r.account_id,r.account_id,r.template_key!,r.account_id,r.template_key!))continue;
  await ctx.db.run("DELETE FROM face_profiles WHERE account_id=? AND id=? AND revision=? AND auth_epoch=? AND status='revoked' AND template_key=?",r.account_id,r.profile_id!,r.profile_revision!,r.profile_epoch!,r.template_key!);
  if(await ctx.db.one('SELECT id FROM face_profiles WHERE account_id=? AND template_key=?',r.account_id,r.template_key!))continue;
  await ctx.db.run("UPDATE audience_review_retirements SET disposition='removed',removal_verified_at=?,profile_id=NULL,profile_revision=NULL,profile_epoch=NULL,auth_consent_id=NULL,auth_policy=NULL,template_key=NULL,template_digest=NULL,cleanup_id=NULL WHERE account_id=? AND audience_version=?",ctx.now(),r.account_id,r.audience_version);
 }
}
export async function maintainAudienceReview(ctx:AppContext):Promise<void> {
 const entity='audience-annual-review-v2';
 type Cursor={last_at:number|null;last_id:string|null};
 let cursor=await ctx.db.one<Cursor>("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='adult' AND entity_id=?",entity);
 const after=cursor?.last_at??null,id=cursor?.last_id??null;
 if((after===null)!==(id===null)||after!==null&&(!Number.isSafeInteger(after)||after<0||typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)))
  throw new ApiError(503,'audience_cursor_invalid');
 const supported="(a.declared_at BETWEEN 0 AND 8639968464000000 AND a.account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";
 const eligible=`${audienceDeadlineSQL('a')}<=? AND ${audienceBandSQL('a')}<>'under13' AND a.status IN('eligible','guardian_pending')
  AND NOT EXISTS(SELECT 1 FROM audience_review_retirements r WHERE r.account_id=a.account_id AND r.audience_version=a.version)`;
 let blocked=!!await ctx.db.one(`SELECT account_id FROM account_audience a WHERE ${eligible} AND NOT ${supported} LIMIT 1`,ctx.now());
 const rows=await ctx.db.all<{account_id:string;declared_at:number;version:number}>(`SELECT a.account_id,a.declared_at,a.version FROM account_audience a
  WHERE ${eligible} AND ${supported} ${after===null?'':'AND (a.declared_at>? OR (a.declared_at=? AND a.account_id>?))'}
  ORDER BY a.declared_at,a.account_id LIMIT 25`,ctx.now(),...(after===null?[]:[after,after,id!]));
 const advance=async(at:number|null,key:string|null)=>{
  const updated=cursor===null?await ctx.db.one<Cursor>("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('adult',?,?,?) ON CONFLICT(scan,entity_id) DO NOTHING RETURNING last_at,last_id",entity,at,key):
   await ctx.db.one<Cursor>("UPDATE retention_scan_cursors SET last_at=?,last_id=? WHERE scan='adult' AND entity_id=? AND last_at IS NOT DISTINCT FROM ? AND last_id IS NOT DISTINCT FROM ? RETURNING last_at,last_id",at,key,entity,cursor.last_at,cursor.last_id);
  if(!updated)throw new ApiError(503,'audience_cursor_changed');cursor=updated;
 };
 for(const selected of rows){
  let unchanged=false;
  try{await ctx.db.transaction(async restore=>{
   const raw=await ctx.db.one('SELECT * FROM account_audience WHERE account_id=?',selected.account_id);
   if(!raw||raw.declared_at!==selected.declared_at||raw.version!==selected.version)return;
   const a=await audienceRow(ctx,selected.account_id);
   if(!a||a.next_review_at>ctx.now()||!['eligible','guardian_pending'].includes(a.status))return;
   const identity={operation_id:await restoreOperationID(a.account_id,'audience.review-expiry-v1','audience.review:'+a.version),input_hash:await digest(stable({account_id:a.account_id,version:a.version,deadline:a.next_review_at,policy_version:a.policy_version})),allocations:{}};
   const prior=await ctx.db.one<{input_hash:string;disposition:string}>("SELECT input_hash,CASE WHEN outcome IN('restricted-abort','restore-retired') THEN 'restrictions_applied' ELSE outcome END disposition FROM restore_recovered_operations WHERE operation_id=?",identity.operation_id);
   if(prior){
    if(prior.input_hash!==identity.input_hash||prior.disposition!=='restrictions_applied')throw new ApiError(503,'restore_reconciliation_required');
    // Restrictions from this logical operation have already committed through
    // restoration. A changed source requiring any additional denial is fresh
    // work; do not suppress it or reuse a terminal independent operation.
    const terminal:RestoreTransactionScope={operation:()=>{throw new ApiError(409,'audience_authority_changed');},restrict:async()=>{throw new ApiError(409,'audience_authority_changed');}};
    await retireAudienceReview(ctx,a,terminal);
   }else{restore.operation(identity);await retireAudienceReview(ctx,a,restore);}
   await advance(selected.declared_at,selected.account_id);unchanged=true;
  });}catch(error){
   if(!(error instanceof ApiError)||!['audience_decision_unavailable','guardian_approval_scope_invalid','audience_authority_changed','audience_future_guardian_episode','audience_review_not_due'].includes(error.code))throw error;
   blocked=true;
   // Only an unchanged, deterministic bad row may consume one cursor position.
   // Unknown SQL/journal/commit failures keep the original position and abort.
   await ctx.db.transaction(async()=>{
    const raw=await ctx.db.one<{declared_at:number;version:number}>('SELECT declared_at,version FROM account_audience WHERE account_id=?',selected.account_id);
    if(raw?.declared_at===selected.declared_at&&raw.version===selected.version){await advance(selected.declared_at,selected.account_id);unchanged=true;}
   });
  }
  if(!unchanged)break;
 }
 if(!rows.length&&cursor&&(cursor.last_at!==null||cursor.last_id!==null))await ctx.db.transaction(()=>advance(null,null));
 await ctx.db.transaction(()=>finishReviewCleanup(ctx));
 if(blocked)throw new ApiError(503,'audience_maintenance_blocked');
}
async function renew(ctx:AppContext,account:string,input:Record<string,unknown>,restore:RestoreTransactionScope,minor:boolean,limit:{value:number}):Promise<{renewal:Renewal}> {
 if(!minor)authConsent(input,ctx);
 const a=await audienceRow(ctx,account);if(!a||a.policy_version!==AUDIENCE_POLICY||a.version!==input.expected_version)throw new ApiError(409,'audience_version_changed');
 if(a.age_band!==(minor?'13_17':'18_plus'))throw new ApiError(409,'audience_age_review_required');
 await noDeletion(ctx,account);
 const old=await ctx.db.one<Retirement>('SELECT * FROM audience_review_retirements WHERE account_id=? AND audience_version=?',account,a.version);
 const deadline=minor?await minorReviewDeadline(ctx,a):a.next_review_at;
 if(deadline>ctx.now())throw new ApiError(409,'audience_review_not_due');
 if(!minor&&a.status!=='eligible'&&!old)throw new ApiError(403,'audience_restricted');
 await retireAudienceReview(ctx,a,restore,deadline);
 const requests=await ctx.db.all<Guardian>("SELECT * FROM guardian_requests WHERE child_account_id=? AND state IN('pending','under_review','approved') ORDER BY created_at,id",account);
 const group=await prepareTerminations(ctx,restore,requests);
 // The expiry above already retired every own purpose/reference. Close the
 // original guardian episodes without applying a second, unrelated profile
 // epoch/version change to the retained, exact recovery reference.
 for(const plan of group.plans)await retireGuardianRequest(ctx,plan.request,'expired',account);
 await storeAudienceDecision(ctx,account,{at_least_13:true,guardian_required:minor},a.version+1,'self_declaration');
 let next:Renewal['next_step']='profile_recovery',requestID:string|undefined;
 if(minor){
  requestID=crypto.randomUUID();
  await ctx.db.run("INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at) VALUES(?,?,'pending',?,?,?,?)",requestID,account,a.version+1,AUDIENCE_POLICY,ctx.now(),ctx.now()+7*86400000);
  next='guardian_review';
 }else{
  const profile=await ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',account);
  const r=profile?await recoverableReviewReference(ctx,account,profile):null;
  if(profile&&r){
   limit.value=Math.min(limit.value,r.recover_until);
   const consentID=crypto.randomUUID();
   await completeReviewReference(ctx,r);
   await ctx.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision) VALUES(?,?,'face_authentication',?,'granted',?,?)",consentID,account,ctx.env.FACE_AUTH_POLICY_VERSION!,ctx.now(),profile.revision);
   await ctx.db.run("UPDATE face_profiles SET status='active',auth_enabled=1,auth_epoch=auth_epoch+1,auth_consent_id=?,consent_id=NULL WHERE account_id=?",consentID,account);
   next='face_login';
  }else if(!profile)await renewPendingEnrollment(ctx,account,a.version,limit);
 }
 await ctx.db.run("INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,'audience.review',?,'{}',?)",crypto.randomUUID(),account,account,account,ctx.now());
 return {renewal:{operation_key:String(input.operation_key),from_version:a.version,to_version:a.version+1,next_step:next,...(requestID?{guardian_request_id:requestID}:{})}};
}
export async function handleAudienceRenewal(request:Request,ctx:AppContext):Promise<Response|null> {
 const path=new URL(request.url).pathname,device=/^\/auth\/face\/audience\/(status|renew|guardian-review)$/.exec(path),session=path==='/me/audience/renew';
 if(!device&&!session)return null;
 if(request.method!=='POST')throw new ApiError(405,'method_not_allowed');
 const step=device?.[1]??'renew',minor=step==='guardian-review',input=await jsonBody(request,8192);
 const common=device?['account_id','device_id','face_handle','request_nonce','request_expires_at','device_signature']:[];
 const allowed=[...common,...(step==='status'?[]:['at_least_13','guardian_required','policy_version','expected_version','operation_key',...(minor?[]:['consent'])])];
 if(Object.keys(input).some(key=>!allowed.includes(key)))throw new ApiError(400,'audience_input_invalid');
 if(step!=='status'){
  const d=decisionInput(input);
  if(!d.at_least_13||d.guardian_required!==minor)throw new ApiError(409,'audience_age_review_required');
  if(input.policy_version!==AUDIENCE_POLICY)throw new ApiError(409,'audience_policy_changed');
  if(!Number.isSafeInteger(input.expected_version)||(input.expected_version as number)<1)throw new ApiError(400,'audience_input_invalid');
  if(!minor)authConsent(input,ctx,false);
 }
 const limit={value:Infinity};
 const fresh=()=>{if(device)nonce(input,ctx);if(ctx.now()>=limit.value)throw new ApiError(409,'audience_reference_recovery_expired');};
 let account:string,actor:Actor|undefined,guard:()=>Promise<void>;
 if(device){
  const selected=await ctx.db.read(()=>binding(ctx,input));account=selected.owner.id;
  const {device_signature,...fields}=input;
  await verifyKey(JSON.parse(selected.device.public_jwk),{protocol:DEVICE_PROTOCOL,step,...fields},device_signature);
  guard=async()=>{fresh();await binding(ctx,input,selected);fresh();};await guard();
 }else{actor=await ctx.authenticate(request);account=actor.accountId;guard=async()=>{fresh();await assertPrivacyActor(actor!,ctx);fresh();};await guard();}
 ctx.db.bindInvocationAuthority?.(guard,fresh,'audience_operation_outcome_unresolved');
 let receipt:{renewal:Renewal}|undefined;
 if(step!=='status'){
  // Request nonces/signatures/handle are proof material, never a durable age or
  // credential journal. The business key keeps one exact reviewed transition.
  const durable={account_id:account,...(device?{device_id:uuid(input.device_id)}:{}),at_least_13:input.at_least_13,guardian_required:input.guardian_required,
   policy_version:input.policy_version,expected_version:input.expected_version,operation_key:input.operation_key,...(minor?{}:{consent:input.consent})};
  const intent=await prepareOperation(device?(minor?'audience.guardian-review-device':'audience.renew-device'):'audience.renew',durable,'audience');
  receipt=device?await executeAudienceDeviceOperation(ctx,account,intent,restore=>renew(ctx,account,input,restore,minor,limit),guard):
   await executeRestrictedOperation(ctx,actor!,intent,restore=>renew(ctx,account,input,restore,false,limit));
 }
 return ctx.db.read(async()=>{
  await guard();
  const result=device?{protocol:DEVICE_PROTOCOL,account_id:account,device_id:uuid(input.device_id),request_nonce:uuid(input.request_nonce),...await statusFields(ctx,account),...receipt}:
   {...await audienceProjection(ctx,account),...receipt};
  await guard();return ok(result);
 });
}
