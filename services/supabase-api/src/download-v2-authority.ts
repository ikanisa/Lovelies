import { assertAudienceCapability, type AudiencePurpose } from './audience.ts';
import { currentPair, currentPhotoPolicy, type MediaAuthority } from './gallery.ts';
import { assertStoreAuthorityFresh, storeAuthorityDeadlines, type StoreAuthorityDeadlines } from './store-authority.ts';
import { ApiError, stable, type Actor, type AppContext } from './types.ts';

/** Exact purpose/consent/deadline capture, re-read by the issuance and content
 * guards in the admitted transaction and at final response release. */
const unavailable=():never=>{throw new ApiError(503,'download_operation_outcome_unresolved');};
type AudienceRow={account_id:string;age_band:string;status:string;version:number;policy_version:string;next_review_at:number|null};
type GuardianRow={approval_id:string;approval_version:number;approval_expires_at:number;request_id:string;request_revision:number;
 request_expires_at:number;guardian_id:string;guardian_version:number;guardian_review_at:number|null;guardian_consent_id:string;
 guardian_consent_created_at:number;guardian_consent_expires_at:number|null};
type Purpose={account_id:string;purpose:AudiencePurpose;fingerprint:string;audience:AudienceRow;guardian:GuardianRow|null};
type Consent={id:string;account_id:string;purpose:string;policy_version:string;status:string;expires_at:number|null;revoked_at:number|null;created_at:number;profile_revision:string|null};
type Admission={protocol:'lovelies-download-admission-v2';store:StoreAuthorityDeadlines;face:Purpose;processing:Purpose;
 processing_consent:Consent;matching:Purpose|null;matching_consent:Consent|null;match_binding:Record<string,unknown>|null;subscription_expires_at:number};
function deadline(value:unknown):value is number|null{return value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function integer(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
async function purposeSnapshot(ctx:AppContext,account:string,purpose:AudiencePurpose):Promise<Purpose>{
 const fingerprint=await assertAudienceCapability(ctx,account,purpose);let parsed:Record<string,unknown>;
 try{const p=JSON.parse(fingerprint);if(!p||typeof p!=='object'||Array.isArray(p))return unavailable();parsed=p;}catch{return unavailable();}
 const audience=await ctx.db.one<AudienceRow>('SELECT account_id,age_band,status,version,policy_version,next_review_at FROM account_audience WHERE account_id=?',account);
 if(!audience||audience.account_id!==account||audience.status!=='eligible'||audience.version!==parsed.version||
  audience.policy_version!==parsed.policy||parsed.purpose!==purpose||!integer(audience.version)||!deadline(audience.next_review_at))return unavailable();
 let guardian:GuardianRow|null=null;
 if(audience.age_band==='13_17'){
  if(typeof parsed.approval!=='string'||typeof parsed.request!=='string'||!integer(parsed.approval_version)||!integer(parsed.request_revision)||!integer(parsed.guardian_version))return unavailable();
  guardian=await ctx.db.one<GuardianRow>(`SELECT p.id approval_id,p.version approval_version,p.expires_at approval_expires_at,
   r.id request_id,r.revision request_revision,r.expires_at request_expires_at,g.account_id guardian_id,g.version guardian_version,
   g.next_review_at guardian_review_at,c.id guardian_consent_id,c.created_at guardian_consent_created_at,c.expires_at guardian_consent_expires_at
   FROM guardian_purpose_approvals p JOIN guardian_requests r ON r.id=p.request_id AND r.child_account_id=p.child_account_id AND r.guardian_account_id=p.guardian_account_id
   JOIN account_audience g ON g.account_id=p.guardian_account_id AND g.version=p.guardian_audience_version
   JOIN face_profiles fp ON fp.account_id=g.account_id AND fp.status='active' AND fp.auth_enabled=1
   JOIN consents c ON c.id=fp.auth_consent_id AND c.account_id=g.account_id AND c.purpose='face_authentication' AND c.status='granted' AND c.revoked_at IS NULL
   WHERE p.id=? AND p.child_account_id=? AND p.purpose=? AND p.status='approved' AND p.revoked_at IS NULL AND p.version=?
   AND r.id=? AND r.revision=? AND r.state='approved' AND g.version=?`,parsed.approval,account,purpose,parsed.approval_version,parsed.request,parsed.request_revision,parsed.guardian_version);
  if(!guardian||!integer(guardian.approval_expires_at)||!integer(guardian.request_expires_at)||!integer(guardian.guardian_consent_created_at)||
   !deadline(guardian.guardian_review_at)||!deadline(guardian.guardian_consent_expires_at))return unavailable();
 }else if(audience.age_band!=='18_plus')return unavailable();
 await assertAudienceCapability(ctx,account,purpose,fingerprint);
 return {account_id:account,purpose,fingerprint,audience,guardian};
}
async function consent(ctx:AppContext,account:string,id:string,purpose:'photo_processing'|'photo_matching'):Promise<Consent>{
 const value=await ctx.db.one<Consent>('SELECT id,account_id,purpose,policy_version,status,expires_at,revoked_at,created_at,profile_revision FROM consents WHERE id=? AND account_id=?',id,account);
 if(!value||value.id!==id||value.account_id!==account||value.purpose!==purpose||value.status!=='granted'||value.revoked_at!==null||
  value.policy_version!==currentPhotoPolicy(ctx)||!integer(value.created_at)||!deadline(value.expires_at)||value.expires_at!==null&&value.expires_at<=ctx.now())return unavailable();
 return value;
}
export async function captureDownloadAdmission(ctx:AppContext,actor:Actor,authority:MediaAuthority,subscriptionExpiry:number):Promise<Admission>{
 if(!integer(subscriptionExpiry)||subscriptionExpiry<=ctx.now())return unavailable();
 const store=await storeAuthorityDeadlines(ctx,actor),face=await purposeSnapshot(ctx,actor.accountId,'face_authentication');
 const processing=await purposeSnapshot(ctx,authority.owner_id,'photo_processing');
 const processingConsent=await consent(ctx,authority.owner_id,authority.processing_consent_id,'photo_processing');
 if(processingConsent.policy_version!==authority.processing_consent_policy_version||processingConsent.created_at!==authority.processing_consent_created_at||
  processingConsent.expires_at!==authority.processing_consent_expires_at)return unavailable();
 let matching:Purpose|null=null,matchingConsent:Consent|null=null,matchBinding:Record<string,unknown>|null=null;
 if(authority.origin==='reviewed_grant'){
  if(authority.recipient_id!==actor.accountId)return unavailable();
  matching=await purposeSnapshot(ctx,actor.accountId,'photo_matching');
  const pair=await currentPair(ctx,authority.owner_id,authority.asset_id,actor.accountId,false);
  const approval=await ctx.db.one<{origin_id:string;candidate_id:string;pair_version:string}>(
   'SELECT origin_id,candidate_id,pair_version FROM sharing_approvals WHERE id=? AND request_id=? AND owner_id=? AND recipient_id=? AND asset_id=?',
   authority.approval_id,authority.request_id,authority.owner_id,actor.accountId,authority.asset_id);
  if(!pair||!approval||pair.origin_id!==approval.origin_id||pair.candidate_id!==approval.candidate_id||pair.version!==approval.pair_version)return unavailable();
  matchingConsent=await consent(ctx,actor.accountId,pair.matching_consent_id,'photo_matching');matchBinding={...pair};
 }
 const result:Admission={protocol:'lovelies-download-admission-v2',store,face,processing,processing_consent:processingConsent,
  matching,matching_consent:matchingConsent,match_binding:matchBinding,subscription_expires_at:subscriptionExpiry};
 assertDownloadAdmissionFresh(result,ctx.now());return result;
}
export function assertDownloadAdmissionFresh(value:Admission,now:number):void{
 if(!value||value.protocol!=='lovelies-download-admission-v2'||!integer(now)||!integer(value.subscription_expires_at))return unavailable();
 assertStoreAuthorityFresh(value.store,now);
 const purposes=[value.face,value.processing,...(value.matching?[value.matching]:[])];
 const values:(number|null)[]=[value.subscription_expires_at,value.processing_consent?.expires_at??null,value.matching_consent?.expires_at??null];
 for(const p of purposes){if(!p||!p.audience)return unavailable();values.push(p.audience.next_review_at);
  if(p.guardian)values.push(p.guardian.approval_expires_at,p.guardian.request_expires_at,p.guardian.guardian_review_at,p.guardian.guardian_consent_expires_at);}
 if(values.some(v=>!deadline(v)||v!==null&&v<=now))return unavailable();
}
export function parseDownloadAdmission(raw:unknown):Admission{
 if(typeof raw!=='string'||raw.length>24000)return unavailable();
 try{const value=JSON.parse(raw) as Admission;if(!value||value.protocol!=='lovelies-download-admission-v2'||stable(value)!==raw)return unavailable();return value;}
 catch{return unavailable();}
}
export function admissionDeadline(value:Admission):number{
 const values:(number|null)[]=[value.store.session_expires_at,value.store.refresh_expires_at,value.store.face_consent_expires_at,
  value.store.audience_review_at,value.store.guardian_approval_expires_at,value.store.guardian_request_expires_at,
  value.store.guardian_audience_review_at,value.store.guardian_face_consent_expires_at,value.subscription_expires_at,
  value.processing_consent.expires_at,value.matching_consent?.expires_at??null];
 for(const p of [value.face,value.processing,...(value.matching?[value.matching]:[])]){values.push(p.audience.next_review_at);
  if(p.guardian)values.push(p.guardian.approval_expires_at,p.guardian.request_expires_at,p.guardian.guardian_review_at,p.guardian.guardian_consent_expires_at);}
 if(values.some(v=>!deadline(v)))return unavailable();return Math.min(...values.filter((v):v is number=>v!==null));
}
