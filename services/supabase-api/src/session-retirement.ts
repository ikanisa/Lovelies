import type { AppContext } from './types.ts';

/** A revocation targets one session. Device-scoped cleanup must not reach a
 * different device revision or account epoch that happens to share its ID. */
export type RetirementSession = {
    id: string;
    account_id: string;
    auth_method: 'anonymous' | 'registered_face';
    auth_epoch: number;
    device_id: string | null;
    device_revision: string | null;
    revoked_at: number | null;
    refresh_consumed_at: number | null;
    created_at: number;
};
type AccountGeneration = { identity_state: string; auth_epoch: number; disabled_at: number | null };
type DeviceGeneration = { id: string; account_id: string; revision: string; status: string };
type PendingControl = { operation_key: string; control_device_id: string; control_revision: string;
    auth_epoch: number; consent_id: string | null; challenge_id: string | null; generation: number; created_at: number };
type SessionChallenge = { id: string; account_id: string | null; device_id: string | null;
    device_revision: string | null; auth_epoch: number | null; purpose: string; status: string;
    consent_id: string | null; profile_id: string | null; profile_revision: string | null; expires_at: number;
    session_id: string | null; used_at: number | null };

/** Read-only selection. Callers compare the complete result again immediately
 * before effects. Unknown/mixed generations permit only session retirement;
 * they never authorize cancellation of the associated lifecycle or challenges. */
export async function sessionRetirementScope(ctx: AppContext, session: RetirementSession) {
    const account = await ctx.db.one<AccountGeneration>('SELECT identity_state,auth_epoch,disabled_at FROM accounts WHERE id=?', session.account_id);
    const device = session.device_id === null ? null : await ctx.db.one<DeviceGeneration>(
        'SELECT id,account_id,revision,status FROM auth_devices WHERE id=? AND account_id=?', session.device_id, session.account_id);
    const controls = session.device_id === null ? [] : await ctx.db.all<PendingControl>(`SELECT operation_key,control_device_id,control_revision,
        auth_epoch,consent_id,challenge_id,generation,created_at FROM face_profile_operations
        WHERE account_id=? AND control_device_id=? AND state='pending' ORDER BY operation_key`, session.account_id, session.device_id);
    // Include foreign or unbound rows in the snapshot, even though they are not
    // eligible for cancellation. Otherwise a malformed row could be modified.
    const challenges = await ctx.db.all<SessionChallenge>(`SELECT id,account_id,device_id,device_revision,auth_epoch,purpose,status,
        consent_id,profile_id,profile_revision,expires_at,session_id,used_at FROM auth_challenges WHERE session_id=? AND used_at IS NULL ORDER BY id`, session.id);
    const challengeDevices = session.device_id !== null ? [] : await ctx.db.all<DeviceGeneration>(`SELECT id,account_id,revision,status FROM auth_devices
        WHERE id IN (SELECT device_id FROM auth_challenges WHERE session_id=? AND used_at IS NULL) ORDER BY id`, session.id);
    // The lifecycle helper also updates challenges reached through operations,
    // including those without a session_id. Snapshot their actual authority.
    const linked = session.device_id === null ? [] : await ctx.db.all<SessionChallenge>(`SELECT c.id,c.account_id,c.device_id,c.device_revision,c.auth_epoch,c.purpose,c.status,
        c.consent_id,c.profile_id,c.profile_revision,c.expires_at,c.session_id,c.used_at FROM auth_challenges c
        WHERE c.id IN (SELECT challenge_id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending') ORDER BY c.id`, session.account_id, session.device_id);
    // A consent shared outside this selection must not be revoked by a device
    // cleanup, even if the selected operation otherwise looks current.
    const shared = session.device_id === null ? [] : await ctx.db.all<{account_id:string; operation_key:string; consent_id:string}>(`SELECT p.account_id,p.operation_key,p.consent_id FROM face_profile_operations p
        WHERE p.state='pending' AND p.consent_id IN (SELECT consent_id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending' AND consent_id IS NOT NULL)
        AND (p.account_id<>? OR p.control_device_id<>?) ORDER BY p.account_id,p.operation_key`, session.account_id, session.device_id, session.account_id, session.device_id);
    // Resume can create a new challenge without changing operation.created_at.
    // A peer can adopt work created before or after it; no timestamp proves
    // exclusive ownership of the current lifecycle episode.
    const peers = session.device_id === null || controls.length === 0 ? [] : await ctx.db.all<{id:string; created_at:number}>(`SELECT id,created_at FROM sessions
        WHERE account_id=? AND device_id=? AND id<>? ORDER BY id`, session.account_id, session.device_id, session.id);
    // The same consent can also support other live challenges, enrollments,
    // recovery keys or sessions without another pending profile-operation row.
    // Do not withdraw it unless every reference is within this selection.
    const otherConsentReferences = session.device_id === null ? [] : await ctx.db.all<{kind:string; id:string; consent_id:string}>(`WITH selected AS (
        SELECT c.id FROM consents c WHERE c.id IN
        (SELECT consent_id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending')
        AND NOT EXISTS (SELECT 1 FROM face_profiles p WHERE p.auth_consent_id=c.id))
        SELECT 'challenge' kind,c.id,c.consent_id FROM auth_challenges c JOIN selected s ON s.id=c.consent_id
          WHERE c.used_at IS NULL AND c.id NOT IN (SELECT challenge_id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending' AND challenge_id IS NOT NULL)
        UNION ALL SELECT 'enrollment' kind,e.enrollment_key id,e.consent_id FROM face_enrollment_intents e JOIN selected s ON s.id=e.consent_id WHERE e.revoked_at IS NULL
        UNION ALL SELECT 'recovery' kind,r.id,r.consent_id FROM face_recovery_keys r JOIN selected s ON s.id=r.consent_id WHERE r.revoked_at IS NULL
        UNION ALL SELECT 'session' kind,x.id,x.face_consent_id consent_id FROM sessions x JOIN selected s ON s.id=x.face_consent_id WHERE x.revoked_at IS NULL AND x.id<>?
        ORDER BY kind,id`, session.account_id, session.device_id, session.account_id, session.device_id, session.id);
    const otherChallengeReferences = session.device_id === null ? [] : await ctx.db.all<{kind:string; id:string; challenge_id:string}>(`WITH selected AS (
        SELECT challenge_id id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending' AND challenge_id IS NOT NULL)
        SELECT 'operation' kind,p.operation_key id,p.challenge_id FROM face_profile_operations p JOIN selected s ON s.id=p.challenge_id
          WHERE p.state='pending' AND (p.account_id<>? OR p.control_device_id<>?)
        UNION ALL SELECT 'enrollment' kind,e.enrollment_key id,e.challenge_id FROM face_enrollment_intents e JOIN selected s ON s.id=e.challenge_id WHERE e.revoked_at IS NULL
        UNION ALL SELECT 'recovery' kind,r.recovery_request_id id,r.challenge_id FROM face_recovery_intents r JOIN selected s ON s.id=r.challenge_id WHERE r.completed_at IS NULL
        ORDER BY kind,id`, session.account_id, session.device_id, session.account_id, session.device_id);
    const currentAccount = account !== null && account.disabled_at === null && account.auth_epoch === session.auth_epoch &&
        account.identity_state === session.auth_method && session.refresh_consumed_at === null;
    const guest = session.auth_method === 'anonymous' && session.device_id === null && session.device_revision === null;
    const registered = session.auth_method === 'registered_face' && session.device_id !== null && session.device_revision !== null &&
        device !== null && device.status === 'active' && device.revision === session.device_revision;
    const sameControls = controls.every(row => row.control_device_id === session.device_id &&
        row.control_revision === session.device_revision && row.auth_epoch === session.auth_epoch);
    const knownChallenge = (row: SessionChallenge) => ['registration', 'login', 'replacement'].includes(row.purpose) &&
        ['pending', 'verifying'].includes(row.status) && row.used_at === null;
    const sameChallenges = challenges.every(row => knownChallenge(row) && row.account_id === session.account_id && row.auth_epoch === session.auth_epoch &&
        (guest ? challengeDevices.some(device => device.id === row.device_id && device.account_id === session.account_id &&
            device.revision === row.device_revision && device.status === 'pending') :
            row.device_id === session.device_id && row.device_revision === session.device_revision));
    const sameLinked = controls.every(op => op.challenge_id === null || linked.some(row => row.id === op.challenge_id && knownChallenge(row) &&
        row.account_id === session.account_id && row.device_id === session.device_id && row.device_revision === session.device_revision &&
        row.auth_epoch === session.auth_epoch && row.consent_id === op.consent_id && (row.session_id === null || row.session_id === session.id)));
    const safe = currentAccount && (guest || registered) && sameControls && sameChallenges && sameLinked && shared.length === 0 &&
        otherConsentReferences.length === 0 && otherChallengeReferences.length === 0 && peers.length === 0;
    return { account, device, controls, challenges, challengeDevices, linked, shared, peers, otherConsentReferences, otherChallengeReferences,
        cancelDeviceLifecycle: safe && registered, cancelSessionChallenges: safe };
}
