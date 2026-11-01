/** Deny-only replay of independently authenticated, exact authority episodes.
 * Never reconstructs a positive operation callback, consent or media grant. */
import {ApiError,stable} from './types.ts';
import type {SqlConnection} from './database.ts';
import type {RestoreRestrictionEvent,RestoreEventReceipt} from './restore-journal.ts';
const bad=():never=>{throw new ApiError(503,'restore_replay_conflict');};
export async function applyRestriction(connection:SqlConnection,event:RestoreRestrictionEvent,at:number):Promise<void>{
 const s=event.scope,q=(sql:string,args:unknown[]=[])=>connection.query(sql,args);
 switch(event.kind){
 case 'consent-withdrawn':
  await q("UPDATE consents SET status='revoked',revoked_at=coalesce(revoked_at,$1) WHERE id=$2 AND account_id=$3 AND purpose=$4",[at,s.consent_id,s.account_id,s.purpose]);
  if(s.purpose==='face_authentication')await q('UPDATE face_profiles SET auth_enabled=0 WHERE auth_consent_id=$1 AND account_id=$2',[s.consent_id,s.account_id]);
  await q("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=$1 AND consent_id=$2 AND state='pending'",[s.account_id,s.consent_id]);
  await q("UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,$1) WHERE account_id=$2 AND consent_id=$3 AND used_at IS NULL",[at,s.account_id,s.consent_id]);
  await q('UPDATE sessions SET revoked_at=coalesce(revoked_at,$1),refresh_consumed_at=coalesce(refresh_consumed_at,$1) WHERE face_consent_id=$2 AND account_id=$3',[at,s.consent_id,s.account_id]);break;
 case 'profile-retired':
  await q("UPDATE face_profiles SET status='revoked',auth_enabled=0 WHERE id=$1 AND account_id=$2 AND revision=$3",[s.profile_id,s.account_id,s.profile_revision]);
  await q('UPDATE sessions SET revoked_at=coalesce(revoked_at,$1),refresh_consumed_at=coalesce(refresh_consumed_at,$1) WHERE account_id=$2 AND face_profile_revision=$3',[at,s.account_id,s.profile_revision]);break;
 case 'session-retired':
  await q('UPDATE sessions SET revoked_at=coalesce(revoked_at,$1),refresh_consumed_at=coalesce(refresh_consumed_at,$1) WHERE id=$2 AND account_id=$3',[at,s.session_id,s.account_id]);
  await q('DELETE FROM media_tickets WHERE session_id=$1 AND account_id=$2',[s.session_id,s.account_id]);
  await q('DELETE FROM download_tickets WHERE session_id=$1 AND account_id=$2',[s.session_id,s.account_id]);
  await q('UPDATE privacy_export_grants SET consumed_at=coalesce(consumed_at,$1) WHERE session_id=$2 AND subject_id=$3',[at,s.session_id,s.account_id]);break;
 case 'device-retired':
  await q("UPDATE auth_devices SET status='revoked',face_handle=NULL WHERE id=$1 AND account_id=$2 AND revision=$3",[s.device_id,s.account_id,s.device_revision]);
  await q('UPDATE sessions SET revoked_at=coalesce(revoked_at,$1),refresh_consumed_at=coalesce(refresh_consumed_at,$1) WHERE device_id=$2 AND account_id=$3 AND device_revision=$4',[at,s.device_id,s.account_id,s.device_revision]);break;
 case 'guardian-approval-retired':
  await q("UPDATE guardian_purpose_approvals SET status='revoked',revoked_at=coalesce(revoked_at,$1) WHERE id=$2 AND request_id=$3 AND child_account_id=$4 AND purpose=$5",[at,s.guardian_approval_id,s.guardian_request_id,s.child_account_id,s.purpose]);break;
 case 'guardian-request-retired':
  await q("UPDATE guardian_requests SET state=$1,revision=revision+1,terminated_at=coalesce(terminated_at,$2) WHERE id=$3 AND child_account_id=$4 AND revision=$5 AND state IN('pending','under_review','approved')",[s.terminal_state,at,s.guardian_request_id,s.child_account_id,Number(s.request_revision)]);break;
 case 'sharing-request-retired':
  await q("UPDATE sharing_requests SET status='revoked',updated_at=$1 WHERE id=$2 AND sender_id=$3 AND recipient_id=$4 AND status IN('requested','accepted')",[at,s.request_id,s.sender_id,s.recipient_id]);
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE request_id=$2 AND owner_id=$3 AND recipient_id=$4',[at,s.request_id,s.sender_id,s.recipient_id]);break;
 case 'asset-retired':
  await q("UPDATE assets SET status='restore_retired',deleted_at=coalesce(deleted_at,$1) WHERE id=$2 AND owner_id=$3 AND version=$4",[at,s.asset_id,s.owner_id,s.asset_version]);
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE asset_id IN(SELECT id FROM assets WHERE id=$2 AND owner_id=$3 AND version=$4)',[at,s.asset_id,s.owner_id,s.asset_version]);break;
 case 'media-grant-retired':
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE id=$2 AND owner_id=$3 AND recipient_id=$4 AND request_id=$5 AND asset_id=$6',[at,s.grant_id,s.owner_id,s.recipient_id,s.request_id,s.asset_id]);break;
 case 'store-entitlement-retired':
  await q('UPDATE store_subscriptions SET active=0 WHERE id=$1 AND account_id=$2 AND version=$3',[s.subscription_id,s.account_id,Number(s.subscription_version)]);
  await q('DELETE FROM download_tickets WHERE subscription_id=$1 AND account_id=$2 AND subscription_version=$3',[s.subscription_id,s.account_id,Number(s.subscription_version)]);break;
 case 'privacy-export-grant-retired':
  await q('UPDATE privacy_export_grants SET consumed_at=coalesce(consumed_at,$1) WHERE id=$2 AND subject_id=$3 AND request_id=$4 AND session_id=$5',[at,s.grant_id,s.account_id,s.request_id,s.session_id]);break;
 case 'privacy-export-publication-retired':
  await q("UPDATE privacy_exports SET status='retired' WHERE id=$1 AND subject_id=$2 AND request_id=$3",[s.publication_id,s.account_id,s.request_id]);break;
 case 'pair-blocked':
  // A later episode can only be created after ending the old one. Replay order
  // updates the exact current episode; ending A cannot remove a newer B.
  await q('INSERT INTO blocks(blocker_id,blocked_id,created_at,episode_id) SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM accounts WHERE id=$1) AND EXISTS(SELECT 1 FROM accounts WHERE id=$2) ON CONFLICT(blocker_id,blocked_id) DO UPDATE SET episode_id=excluded.episode_id,created_at=excluded.created_at',[s.blocker_id,s.blocked_id,at,s.block_operation_id]);
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE (owner_id=$2 AND recipient_id=$3) OR(owner_id=$3 AND recipient_id=$2)',[at,s.blocker_id,s.blocked_id]);break;
 case 'pair-block-ended':await q('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2 AND episode_id=$3',[s.blocker_id,s.blocked_id,s.block_operation_id]);break;
 case 'operator-capability-retired':
  await q('UPDATE operator_capability_grants SET revoked_at=coalesce(revoked_at,$1) WHERE id=$2 AND account_id=$3 AND capability=$4',[at,s.grant_id,s.account_id,s.capability]);break;
 case 'push-device-retired':
  await q('UPDATE push_devices SET active=0 WHERE id=$1 AND account_id=$2 AND token_hash=$3',[s.device_id,s.account_id,s.token_hash]);
  await q("UPDATE notification_deliveries SET status='cancelled',updated_at=$1 WHERE device_id=$2 AND token_hash=$3 AND status='queued' AND attempts=0 AND lease_token IS NULL AND provider_receipt IS NULL",[at,s.device_id,s.token_hash]);break;
 case 'candidate-retired':await q("UPDATE candidates SET status='invalidated' WHERE id=$1 AND owner_id=$2 AND recipient_id=$3 AND version=$4",[s.candidate_id,s.owner_id,s.recipient_id,s.candidate_version]);break;
 case 'account-moderation-restricted':
  await q("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) SELECT $1,$2,1,$3,'restore_replayed_restriction' WHERE EXISTS(SELECT 1 FROM accounts WHERE id=$2) ON CONFLICT(id) DO UPDATE SET active=1,cleared_at=NULL",[s.hold_id,s.account_id,at]);
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE owner_id=$2 OR recipient_id=$2',[at,s.account_id]);break;
 case 'asset-moderation-restricted':
  await q("INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) SELECT $1,$2,1,$3,'restore_replayed_restriction' WHERE EXISTS(SELECT 1 FROM assets WHERE id=$2 AND owner_id=$4) ON CONFLICT(id) DO UPDATE SET active=1,cleared_at=NULL",[s.hold_id,s.asset_id,at,s.owner_id]);
  await q('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,$1) WHERE asset_id=$2 AND owner_id=$3',[at,s.asset_id,s.owner_id]);break;
 case 'moderation-restriction-ended':await q('UPDATE moderation_holds SET active=0,cleared_at=coalesce(cleared_at,$1) WHERE id=$2',[at,s.hold_id]);break;
 case 'account-authority-retired':
  await q('UPDATE accounts SET disabled_at=coalesce(disabled_at,$1) WHERE id=$2 AND auth_epoch=$3',[at,s.account_id,Number(s.auth_epoch)]);break;
 case 'notification-setting-retired':{
  const column=['match_alerts','payment_alerts','support_alerts'].includes(s.setting)?s.setting:bad();
  await q('UPDATE notification_settings SET '+column+'=0 WHERE account_id=$1 AND updated_at<=$2',[s.account_id,Number(s.updated_at)]);break;
 }
 case 'global-retention-hold-started':await q('UPDATE retention_settings SET legal_hold=1,restore_hold_episode_id=$1',[s.hold_id]);break;
 case 'global-retention-hold-ended':await q('UPDATE retention_settings SET legal_hold=0,restore_hold_episode_id=NULL WHERE restore_hold_episode_id=$1',[s.hold_id]);break;
 case 'asset-retention-hold-started':await q('UPDATE asset_retention SET legal_hold=1,restore_hold_episode_id=$1 WHERE asset_id=$2 AND EXISTS(SELECT 1 FROM assets a WHERE a.id=$2 AND a.owner_id=$3)',[s.hold_id,s.asset_id,s.owner_id]);break;
 case 'asset-retention-hold-ended':await q('UPDATE asset_retention SET legal_hold=0,restore_hold_episode_id=NULL WHERE asset_id=$1 AND restore_hold_episode_id=$2',[s.asset_id,s.hold_id]);break;
 case 'privacy-hold-started':await q('UPDATE privacy_requests SET legal_hold=1,restore_hold_episode_id=$1 WHERE id=$2 AND subject_id=$3',[s.hold_id,s.request_id,s.account_id]);break;
 case 'privacy-hold-ended':await q('UPDATE privacy_requests SET legal_hold=0,restore_hold_episode_id=NULL WHERE id=$1 AND subject_id=$2 AND restore_hold_episode_id=$3',[s.request_id,s.account_id,s.hold_id]);break;
 case 'account-deletion-requested':
  // Requests are recorded separately; a requested deletion is not independent
  // approval, and neither request/rejection can be replayed as completed erasure.
  await q("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) SELECT $1,$2,$2,'delete','pending_approval',$3,$4 WHERE EXISTS(SELECT 1 FROM accounts WHERE id=$2) ON CONFLICT(id) DO NOTHING",[s.deletion_request_id,s.account_id,at,at+31536000000]);break;
 case 'account-deletion-reviewed':
  await q("UPDATE privacy_requests SET status=$1,reviewed_by=$2,reviewed_at=$3,review_reason='restore_replayed_independent_decision' WHERE id=$4 AND subject_id=$5 AND request_type='delete' AND status NOT IN('completed','processing') AND EXISTS(SELECT 1 FROM accounts WHERE id=$2)",[s.decision==='approved'?'queued':'rejected',s.reviewer_id,at,s.deletion_request_id,s.account_id]);
  if(s.decision==='approved')await q('UPDATE accounts SET disabled_at=coalesce(disabled_at,$1) WHERE id=$2',[at,s.account_id]);break;
 case 'account-erased':
  // Reconstitute a restrictive erasure work item, never a fabricated physical
  // cleanup completion. The normal deletion worker owns redaction/expiry.
  await q('UPDATE accounts SET disabled_at=coalesce(disabled_at,$1) WHERE id=$2',[at,s.account_id]);
  await q("UPDATE privacy_requests SET status='queued',metadata_erased_at=NULL,completed_at=NULL WHERE id=$1 AND subject_id=$2 AND request_type='delete' AND reviewed_by IS NOT NULL",[s.deletion_request_id,s.account_id]);break;
 default:return bad();
 }
}
export async function applyRestrictionReceipt(connection:SqlConnection,receipt:RestoreEventReceipt,at:number):Promise<void>{
 const old=await connection.query<{hash:string;operation_id:string;kind:string;scope_json:string}>('SELECT hash,operation_id,kind,scope_json FROM restore_replay_facts WHERE sequence=$1',[receipt.sequence]);
 if(old.length){if(old.length!==1||old[0].hash!==receipt.hash||old[0].operation_id!==receipt.event.operation_id||old[0].kind!==receipt.event.kind||stable(JSON.parse(old[0].scope_json))!==stable(receipt.event.scope))return bad();return;}
 await applyRestriction(connection,receipt.event,at);
 await connection.query('INSERT INTO restore_replay_facts(sequence,hash,operation_id,kind,scope_json,applied_at) VALUES($1,$2,$3,$4,$5,$6)',[receipt.sequence,receipt.hash,receipt.event.operation_id,receipt.event.kind,stable(receipt.event.scope),at]);
}
