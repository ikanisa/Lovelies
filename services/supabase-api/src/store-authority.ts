import { assertAudienceCapability } from './audience.ts';
import { assertRegisteredActor } from './operations.ts';
import { ApiError, stable, type Actor, type AppContext } from './types.ts';

/** Only the deadlines of the exact validated actor and selected guardian
 * authority are retained. Null means the corresponding deadline is unbounded. */
export type StoreAuthorityDeadlines = Readonly<{
  session_expires_at:number; refresh_expires_at:number;
  face_consent_expires_at:number|null; audience_review_at:number|null;
  guardian_approval_expires_at:number|null; guardian_request_expires_at:number|null;
  guardian_audience_review_at:number|null; guardian_face_consent_expires_at:number|null;
}>;
type OwnDeadlines={session_expires_at:number;refresh_expires_at:number;face_consent_expires_at:number|null;
  audience_review_at:number|null;age_band:string;audience_version:number;audience_policy:string};
type GuardianDeadlines={guardian_approval_expires_at:number;guardian_request_expires_at:number;
  guardian_audience_review_at:number|null;guardian_face_consent_expires_at:number|null};
const unavailable=():never=>{throw new ApiError(503,'store_authority_unavailable');};
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const optionalDeadline=(value:unknown):boolean=>value===null||integer(value);

/** This synchronous boundary runs after every admitted authority read and
 * immediately before SQL COMMIT and response release. */
export function assertStoreAuthorityFresh(value:StoreAuthorityDeadlines, now:number):void {
  if(!integer(now)||!integer(value.session_expires_at)||!integer(value.refresh_expires_at)||
    !optionalDeadline(value.face_consent_expires_at)||!optionalDeadline(value.audience_review_at)||
    !optionalDeadline(value.guardian_approval_expires_at)||!optionalDeadline(value.guardian_request_expires_at)||
    !optionalDeadline(value.guardian_audience_review_at)||!optionalDeadline(value.guardian_face_consent_expires_at)) return unavailable();
  if(value.session_expires_at<=now||value.refresh_expires_at<=now) throw new ApiError(401,'session_invalid');
  for(const deadline of [value.face_consent_expires_at,value.audience_review_at,value.guardian_approval_expires_at,
    value.guardian_request_expires_at,value.guardian_audience_review_at,value.guardian_face_consent_expires_at])
    if(deadline!==null&&deadline<=now) throw new ApiError(403,'store_authority_expired');
}

async function exactDeadlines(ctx:AppContext,actor:Actor,audience:Record<string,unknown>):Promise<StoreAuthorityDeadlines> {
  const own=await ctx.db.one<OwnDeadlines>(`SELECT s.expires_at session_expires_at,s.refresh_expires_at,
    c.expires_at face_consent_expires_at,a.next_review_at audience_review_at,a.age_band,
    a.version audience_version,a.policy_version audience_policy
    FROM sessions s JOIN face_profiles fp ON fp.account_id=s.account_id AND fp.revision=s.face_profile_revision
      AND fp.auth_epoch=s.face_profile_epoch AND fp.auth_consent_id=s.face_consent_id AND fp.status='active' AND fp.auth_enabled=1
    JOIN consents c ON c.id=fp.auth_consent_id AND c.account_id=s.account_id AND c.purpose='face_authentication'
      AND c.status='granted' AND c.revoked_at IS NULL AND c.policy_version=? AND (c.profile_revision IS NULL OR c.profile_revision=fp.revision)
    JOIN account_audience a ON a.account_id=s.account_id AND a.status='eligible'
    WHERE s.id=? AND s.account_id=? AND s.revoked_at IS NULL AND s.auth_method='registered_face'`,
    ctx.env.FACE_AUTH_POLICY_VERSION??'',actor.sessionId,actor.accountId);
  if(!own||own.session_expires_at!==actor.expiresAt||own.audience_policy!==audience.policy||
    own.audience_version!==audience.version||audience.purpose!=='face_authentication'||
    !['18_plus','13_17'].includes(own.age_band)) return unavailable();
  let guardian:GuardianDeadlines|null=null;
  if(own.age_band==='13_17'){
    if(typeof audience.approval!=='string'||typeof audience.request!=='string'||
      !integer(audience.approval_version)||!integer(audience.request_revision)||!integer(audience.guardian_version)) return unavailable();
    guardian=await ctx.db.one<GuardianDeadlines>(`SELECT p.expires_at guardian_approval_expires_at,
      r.expires_at guardian_request_expires_at,g.next_review_at guardian_audience_review_at,
      c.expires_at guardian_face_consent_expires_at
      FROM guardian_purpose_approvals p JOIN guardian_requests r ON r.id=p.request_id AND r.child_account_id=p.child_account_id
        AND r.guardian_account_id=p.guardian_account_id AND r.state='approved'
      JOIN account_audience g ON g.account_id=p.guardian_account_id AND g.age_band='18_plus' AND g.status='eligible'
      JOIN accounts ga ON ga.id=g.account_id AND ga.disabled_at IS NULL AND ga.identity_state='registered_face'
      JOIN face_profiles fp ON fp.account_id=ga.id AND fp.status='active' AND fp.auth_enabled=1
      JOIN consents c ON c.id=fp.auth_consent_id AND c.account_id=ga.id AND c.purpose='face_authentication'
        AND c.status='granted' AND c.revoked_at IS NULL AND c.policy_version=?
      WHERE p.id=? AND r.id=? AND p.child_account_id=? AND p.version=? AND r.revision=? AND g.version=?
        AND p.purpose='face_authentication' AND p.status='approved' AND p.revoked_at IS NULL`,
      ctx.env.FACE_AUTH_POLICY_VERSION??'',audience.approval,audience.request,actor.accountId,
      audience.approval_version,audience.request_revision,audience.guardian_version);
    if(!guardian||!integer(guardian.guardian_approval_expires_at)||!integer(guardian.guardian_request_expires_at)) return unavailable();
  }
  return Object.freeze({session_expires_at:own.session_expires_at,refresh_expires_at:own.refresh_expires_at,
    face_consent_expires_at:own.face_consent_expires_at,audience_review_at:own.audience_review_at,
    guardian_approval_expires_at:guardian?.guardian_approval_expires_at??null,
    guardian_request_expires_at:guardian?.guardian_request_expires_at??null,
    guardian_audience_review_at:guardian?.guardian_audience_review_at??null,
    guardian_face_consent_expires_at:guardian?.guardian_face_consent_expires_at??null});
}

/** Capture the exact registered session, face consent and selected audience
 * authority in the caller's admitted transaction. Repeat the checks and
 * deadline read to reject a changed authority snapshot. */
export async function storeAuthorityDeadlines(ctx:AppContext,actor:Actor):Promise<StoreAuthorityDeadlines> {
  await assertRegisteredActor(ctx,actor);
  const fingerprint=await assertAudienceCapability(ctx,actor.accountId,'face_authentication');
  let parsed:unknown;
  try{parsed=JSON.parse(fingerprint);}catch{return unavailable();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) return unavailable();
  const audience=parsed as Record<string,unknown>;
  const first=await exactDeadlines(ctx,actor,audience);
  await assertRegisteredActor(ctx,actor);
  await assertAudienceCapability(ctx,actor.accountId,'face_authentication',fingerprint);
  const last=await exactDeadlines(ctx,actor,audience);
  if(stable(first)!==stable(last)) return unavailable();
  assertStoreAuthorityFresh(last,ctx.now());
  return last;
}
