import { assertPrivacyActor } from './auth.ts';
import { ApiError, stable, type Actor, type AppContext } from './types.ts';

type PrivacyDeadlines=Readonly<{session_expires_at:number;refresh_expires_at:number}>;
const unavailable=():never=>{throw new ApiError(503,'privacy_authority_unavailable');};
function fresh(value:PrivacyDeadlines,now:number):void {
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(value.session_expires_at)||!Number.isSafeInteger(value.refresh_expires_at))return unavailable();
    if(value.session_expires_at<=now||value.refresh_expires_at<=now)throw new ApiError(401,'session_invalid');
}
async function deadlines(ctx:AppContext,actor:Actor):Promise<PrivacyDeadlines> {
    const read=async()=>ctx.db.one<{session_expires_at:number;refresh_expires_at:number}>(
        'SELECT expires_at session_expires_at,refresh_expires_at FROM sessions WHERE id=? AND account_id=?',actor.sessionId,actor.accountId);
    await assertPrivacyActor(actor,ctx);
    const first=await read();
    await assertPrivacyActor(actor,ctx);
    const last=await read();
    if(!first||!last||first.session_expires_at!==actor.expiresAt||stable(first)!==stable(last))return unavailable();
    const value=Object.freeze({session_expires_at:last.session_expires_at,refresh_expires_at:last.refresh_expires_at});
    fresh(value,ctx.now());return value;
}
export type PrivacyGrantGuard={protect(check:()=>Promise<void>,liveDeadline?:number,expiredFloor?:number):void};
/** Own-privacy authority uses the current actor and its session/refresh
 * deadlines. It does not impose face-consent or audience capability checks.
 * The selected grant evidence is re-read in every later admitted transaction. */
export function bindPrivacyGrantAuthority(ctx:AppContext,actor:Actor):PrivacyGrantGuard {
    const bound={...actor,roles:[...actor.roles]};let captured:PrivacyDeadlines|undefined;
    let evidence:{check:()=>Promise<void>;liveDeadline?:number;expiredFloor?:number}|undefined;
    ctx.db.bindInvocationAuthority(async()=>{
        captured=await deadlines(ctx,bound);
        if(evidence)await evidence.check();
    },()=>{
        if(!captured)return unavailable();
        fresh(captured,ctx.now());
        // Do not send a live bearer if its exact deadline passes between the
        // last admitted read and response release. A retry revalidates evidence.
        if(evidence?.liveDeadline!==undefined && evidence.liveDeadline<=ctx.now() ||
            evidence?.expiredFloor!==undefined && evidence.expiredFloor>ctx.now())
            throw new ApiError(503,'privacy_export_grant_reconciliation_required');
    },'privacy_export_grant_outcome_unresolved');
    return {protect(check,liveDeadline,expiredFloor){
        if(typeof check!=='function'||liveDeadline!==undefined&&!Number.isSafeInteger(liveDeadline)||
            expiredFloor!==undefined&&!Number.isSafeInteger(expiredFloor))return unavailable();
        evidence={check,liveDeadline,expiredFloor};
    }};
}
