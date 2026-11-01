import {ApiError,digest,jsonBody,stable,type AppContext,type Database} from './types.ts';

const PLAN='lovelies-push-attempt-plan-v2',ROSTER='lovelies-push-attempt-roster-v2',RECEIPT='lovelies-push-dispatch-receipt-v2';
const DISPATCH='lovelies-push-request-v2';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const PROJECT='ltqfplqevxztlswlzexn';
const terminal=new Set(['accepted','rejected','cancelled']);
const exact=(value:unknown,keys:string[]):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export class PushRosterHold extends ApiError {}
function hold(code='push_roster_unverified'):never{throw new PushRosterHold(503,code);}
type Entry={operation_key:string;device_id:string;platform:string;token_sha256:string;request_sha256:string};
type Plan={protocol:string;ledger_id:string;ledger_bootstrap_id:string;notification_id:string;subject_sha256:string;provider_generation:string;attempts:Entry[]};
type Receipt={protocol:string;operation_key:string;notification_id:string;plan_sha256:string;provider_generation:string;request_sha256:string;
    token_sha256:string;provider_request_id:string;status:string;provider_message_id?:string|null;provider_code?:string|null;retryable?:boolean;token_invalid?:boolean};
type Roster={plan:Plan|null;plan_sha256:string|null;retired:boolean;receipts:Receipt[]};
type Envelope={protocol:string;project_id:string;ledger_id:string;ledger_bootstrap_id:string;control:Record<string,any>;result:Roster};
type Job={notification_id:string;account_id:string;auth_epoch:number;kind:string;title:string;entity_id:string;status:string};
type Device={id:string;account_id:string;auth_device_id:string;platform:string;token_hash:string;token_value:string};
const subjectHash=(id:string)=>digest('lovelies-push-subject-v2:'+id);
export const usesPushRoster=(ctx:AppContext):boolean=>ctx.env.APP_ENV!=='test'||
    !!(ctx.env.PUSH_PROVIDER_GENERATION||ctx.env.PUSH_LEDGER_ID||ctx.env.PUSH_LEDGER_BOOTSTRAP_ID);
export async function requiresPushRoster(ctx:AppContext,id:string):Promise<boolean>{
    return usesPushRoster(ctx)||!!await ctx.db.one('SELECT notification_id FROM notification_dispatch_plans WHERE notification_id=?',id)||
        !!await ctx.db.one('SELECT notification_id FROM notification_recovered_receipts WHERE notification_id=? LIMIT 1',id);
}
function configured(ctx:AppContext){
    if(!ctx.env.PUSH_SERVICE||!HASH.test(ctx.env.PUSH_PROVIDER_GENERATION??'')||!UUID.test(ctx.env.PUSH_LEDGER_ID??'')||!UUID.test(ctx.env.PUSH_LEDGER_BOOTSTRAP_ID??''))hold('push_roster_configuration_required');
    return {generation:ctx.env.PUSH_PROVIDER_GENERATION!,ledger:ctx.env.PUSH_LEDGER_ID!,bootstrap:ctx.env.PUSH_LEDGER_BOOTSTRAP_ID!};
}
async function external(ctx:AppContext,path:string,body?:unknown):Promise<Record<string,any>>{
    configured(ctx);let response:Response;
    try{response=await ctx.env.PUSH_SERVICE!.fetch('https://push.internal'+path,{method:body===undefined?'GET':'POST',redirect:'manual',
        ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:stable(body)})});}
    catch(error){if(error instanceof ApiError)throw error;hold('push_provider_unavailable');}
    if(response.redirected){void response.body?.cancel().catch(()=>{});hold();}
    let value:Record<string,any>;
    try{value=await jsonBody(response as unknown as Request,32768);}catch(error){
        if(error instanceof ApiError&&error.code==='json_body_configuration_invalid')throw error;hold();}
    if(!response.ok){
        // A preflight503 can still contain a precisely bound, non-dispatched
        // receipt. The caller validates that complete receipt before using it.
        if(response.status===503&&value.protocol===RECEIPT)return value;
        hold(['push_provider_generation_changed','push_plan_retired','push_subject_retired'].includes(value.error)?value.error:'push_provider_unavailable');
    }
    return value;
}
function planValue(value:unknown,ctx:AppContext,id:string,subject:string):Plan{
    const config=configured(ctx);
    if(!exact(value,['protocol','ledger_id','ledger_bootstrap_id','notification_id','subject_sha256','provider_generation','attempts'])||
        value.protocol!==PLAN||value.ledger_id!==config.ledger||value.ledger_bootstrap_id!==config.bootstrap||value.notification_id!==id||
        value.subject_sha256!==subject||!HASH.test(value.provider_generation)||!Array.isArray(value.attempts)||value.attempts.length>10)hold();
    let previous='';
    for(const entry of value.attempts){
        if(!exact(entry,['operation_key','device_id','platform','token_sha256','request_sha256'])||!UUID.test(entry.device_id)||
            entry.operation_key!=='notification:'+id+':'+entry.device_id||entry.operation_key<=previous||!['ios','android'].includes(entry.platform)||
            !HASH.test(entry.token_sha256)||!HASH.test(entry.request_sha256))hold();
        previous=entry.operation_key;
    }
    return value as Plan;
}
function receiptValue(value:unknown,plan:Plan,planHash:string):Receipt{
    const required=['protocol','operation_key','notification_id','plan_sha256','provider_generation','request_sha256','token_sha256','provider_request_id','status'];
    const outcome=['provider_message_id','provider_code','retryable','token_invalid'];
    if(!value||typeof value!=='object'||Array.isArray(value))hold();const r=value as Record<string,any>;
    if(required.some(key=>!Object.hasOwn(r,key))||Object.keys(r).some(key=>![...required,...outcome].includes(key))||
        r.protocol!==RECEIPT||r.notification_id!==plan.notification_id||r.plan_sha256!==planHash||r.provider_generation!==plan.provider_generation||
        !UUID.test(r.provider_request_id)||!['unstarted','preparing','dispatching','accepted','rejected','ambiguous','cancelled'].includes(r.status))hold();
    const entry=plan.attempts.find(entry=>entry.operation_key===r.operation_key);
    if(!entry||r.request_sha256!==entry.request_sha256||r.token_sha256!==entry.token_sha256)hold();
    if(['accepted','rejected'].includes(r.status)){
        if(outcome.some(key=>!Object.hasOwn(r,key))||typeof r.retryable!=='boolean'||typeof r.token_invalid!=='boolean'||
            r.provider_message_id!==null&&(typeof r.provider_message_id!=='string'||!r.provider_message_id||r.provider_message_id.length>256)||
            r.provider_code!==null&&(typeof r.provider_code!=='string'||!r.provider_code||r.provider_code.length>80)||
            r.status==='accepted'&&r.provider_message_id===null)hold();
    }else if(outcome.some(key=>Object.hasOwn(r,key)))hold();
    return r as Receipt;
}
function control(value:unknown):Record<string,any>{
    if(!exact(value,['provider_generation','state','reason','revision','plans','attempts','started','settled','retired_subjects'])||
        !HASH.test(value.provider_generation)||!['serving','quarantined'].includes(value.state)||
        value.state==='serving'&&value.reason!==null||value.state==='quarantined'&&!['ledger_recovery_required','provider_generation_retirement','storage_integrity_unconfirmed'].includes(value.reason)||
        ['revision','plans','attempts','started','settled','retired_subjects'].some(key=>!integer(value[key]))||value.settled>value.started||value.started>value.attempts)hold();
    return value;
}
function baseEnvelope(value:unknown,ctx:AppContext):Record<string,any>{
    const config=configured(ctx);
    if(!exact(value,['protocol','project_id','ledger_id','ledger_bootstrap_id','control','result'])||value.protocol!==ROSTER||value.project_id!==PROJECT||
        value.ledger_id!==config.ledger||value.ledger_bootstrap_id!==config.bootstrap)hold();
    control(value.control);return value;
}
export async function pushRosterReady(ctx:AppContext):Promise<boolean>{
    if(!usesPushRoster(ctx))return true;
    try{
        const config=configured(ctx),value=await external(ctx,'/ready');
        if(!exact(value,['protocol','project_id','ledger_id','ledger_bootstrap_id','control'])||value.protocol!==ROSTER||value.project_id!==PROJECT||
            value.ledger_id!==config.ledger||value.ledger_bootstrap_id!==config.bootstrap)return false;
        const current=control(value.control);
        return current.state==='serving'&&current.provider_generation===config.generation;
    }catch{return false;}
}
async function rosterValue(value:unknown,ctx:AppContext,id:string,subject:string):Promise<Envelope>{
    const envelope=baseEnvelope(value,ctx),roster=envelope.result;
    if(!exact(roster,['plan','plan_sha256','retired','receipts'])||typeof roster.retired!=='boolean'||!Array.isArray(roster.receipts))hold();
    if(roster.plan===null){if(roster.plan_sha256!==null||roster.receipts.length!==0)hold();}
    else{
        const plan=planValue(roster.plan,ctx,id,subject);
        if(roster.plan_sha256!==await digest(stable(plan))||roster.receipts.length!==plan.attempts.length)hold();
        for(const [index,receipt] of roster.receipts.entries()){
            const exact=receiptValue(receipt,plan,roster.plan_sha256);
            if(exact.operation_key!==plan.attempts[index].operation_key)hold();
        }
    }
    return envelope as Envelope;
}
async function assertJob(ctx:AppContext,job:Job):Promise<void>{
    const row=await ctx.db.one<Job>('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.notification_id=?',job.notification_id);
    if(!row||row.account_id!==job.account_id||row.auth_epoch!==job.auth_epoch||row.kind!==job.kind||row.title!==job.title||row.entity_id!==job.entity_id)
        throw new ApiError(409,'notification_authority_changed');
}
async function savePlan(ctx:AppContext,plan:Plan,planHash:string):Promise<void>{
    const previous=await ctx.db.one<{plan_json:string;plan_sha256:string}>('SELECT plan_json,plan_sha256 FROM notification_dispatch_plans WHERE notification_id=?',plan.notification_id);
    if(previous){if(previous.plan_sha256!==planHash||previous.plan_json!==stable(plan))hold('push_local_plan_conflict');return;}
    await ctx.db.run(`INSERT INTO notification_dispatch_plans(notification_id,subject_sha256,provider_generation,plan_sha256,plan_json,created_at) VALUES(?,?,?,?,?,?)`,
        plan.notification_id,plan.subject_sha256,plan.provider_generation,planHash,stable(plan),ctx.now());
}
async function recordReceipt(ctx:AppContext,job:Job,plan:Plan,planHash:string,receipt:Receipt):Promise<void>{
    const entry=plan.attempts.find(entry=>entry.operation_key===receipt.operation_key)!;
    const previous=await ctx.db.one<any>('SELECT * FROM notification_recovered_receipts WHERE operation_key=?',entry.operation_key);
    if(previous){
        if(previous.notification_id!==job.notification_id||previous.plan_sha256!==planHash||previous.device_id!==entry.device_id||
            previous.token_sha256!==entry.token_sha256||previous.request_sha256!==entry.request_sha256||previous.provider_generation!==plan.provider_generation)hold('push_local_receipt_conflict');
        if(terminal.has(previous.status)){
            if(terminal.has(receipt.status)&&(previous.status!==receipt.status||previous.provider_receipt!==(receipt.provider_message_id??null)||
                previous.provider_code!==(receipt.provider_code??null)))hold('push_local_receipt_conflict');
            return; // A stale concurrent GET cannot erase a terminal observation.
        }
    }
    const examined=Math.max(ctx.now(),(previous?.updated_at??0)+1);
    if(!Number.isSafeInteger(examined))hold('push_receipt_sequence_exhausted');
    await ctx.db.run(`INSERT INTO notification_recovered_receipts(operation_key,notification_id,plan_sha256,device_id,token_sha256,request_sha256,provider_generation,status,provider_receipt,provider_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET status=excluded.status,provider_receipt=excluded.provider_receipt,provider_code=excluded.provider_code,updated_at=excluded.updated_at`,
        entry.operation_key,job.notification_id,planHash,entry.device_id,entry.token_sha256,entry.request_sha256,plan.provider_generation,receipt.status,
        receipt.provider_message_id??null,receipt.provider_code??null,ctx.now(),examined);
    if(receipt.status==='rejected'&&receipt.token_invalid)
        await ctx.db.run("UPDATE push_devices SET active=0,token_value='',updated_at=? WHERE id=? AND account_id=? AND token_hash=?",ctx.now(),entry.device_id,job.account_id,entry.token_sha256);
}
async function saveRoster(ctx:AppContext,job:Job,envelope:Envelope):Promise<void>{
    await ctx.db.transaction(async()=>{
        await assertJob(ctx,job);
        if(envelope.result.plan){
            await savePlan(ctx,envelope.result.plan,envelope.result.plan_sha256!);
            for(const receipt of envelope.result.receipts)await recordReceipt(ctx,job,envelope.result.plan,envelope.result.plan_sha256!,receipt);
        }else if(await ctx.db.one('SELECT operation_key FROM notification_recovered_receipts WHERE notification_id=? LIMIT 1',job.notification_id))hold('push_independent_history_missing');
    });
}
function dispatch(job:Job,device:Device,plan:Pick<Plan,'subject_sha256'|'provider_generation'>){
    return {protocol:DISPATCH,subject_sha256:plan.subject_sha256,provider_generation:plan.provider_generation,
        operation_key:'notification:'+job.notification_id+':'+device.id,platform:device.platform,token:device.token_value,
        notification:{id:job.notification_id,title:job.title,kind:job.kind,entity_id:job.entity_id}};
}
async function currentDevice(ctx:AppContext,job:Job,entry:Entry):Promise<Device|null>{
    const device=await ctx.db.one<Device>(`SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active'
        WHERE p.id=? AND p.account_id=? AND p.active=1 AND p.platform=? AND p.token_hash=?`,entry.device_id,job.account_id,entry.platform,entry.token_sha256);
    return device&&await digest(device.token_value)===entry.token_sha256?device:null;
}
async function priorLegacyAttempt(ctx:AppContext,id:string):Promise<boolean>{
    return !!await ctx.db.one(`SELECT id FROM notification_deliveries WHERE notification_id=? AND
        (attempts>0 OR provider_receipt IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL OR status IN('dispatching','accepted','ambiguous')) LIMIT 1`,id);
}
/** Operator repair may resume an exact, independently admitted unsent plan. It
 * cannot create a plan, relabel history, or turn an unknown outcome into retry
 * authority. The caller rechecks current application authorization. */
export async function pushQueueRepairEvidence(ctx:AppContext,job:Job):Promise<Record<string,unknown>>{
    if(!usesPushRoster(ctx))throw new ApiError(409,'queue_notification_independent_proof_required');
    const config=configured(ctx),subject=await subjectHash(job.account_id);
    const envelope=await rosterValue(await external(ctx,'/notifications/'+job.notification_id),ctx,job.notification_id,subject);
    const plan=envelope.result.plan;
    if(!plan||envelope.result.retired||envelope.control.state!=='serving'||envelope.control.provider_generation!==config.generation||
        plan.provider_generation!==config.generation||envelope.result.receipts.some(row=>row.status!=='unstarted')||!plan.attempts.length||
        await priorLegacyAttempt(ctx,job.notification_id))throw new ApiError(409,'queue_notification_not_pristine');
    const local=await ctx.db.one<{plan_json:string;plan_sha256:string}>('SELECT plan_json,plan_sha256 FROM notification_dispatch_plans WHERE notification_id=?',job.notification_id);
    if(!local||local.plan_sha256!==envelope.result.plan_sha256||local.plan_json!==stable(plan))throw new ApiError(409,'queue_notification_plan_changed');
    const saved=await ctx.db.all<{operation_key:string;device_id:string;status:string;plan_sha256:string;request_sha256:string;token_sha256:string;provider_generation:string;provider_receipt:string|null;provider_code:string|null}>(
        'SELECT operation_key,device_id,status,plan_sha256,request_sha256,token_sha256,provider_generation,provider_receipt,provider_code FROM notification_recovered_receipts WHERE notification_id=?',job.notification_id);
    for(const row of saved){
        const entry=plan.attempts.find(entry=>entry.operation_key===row.operation_key);
        if(!entry||row.device_id!==entry.device_id||row.status!=='unstarted'||row.provider_receipt!==null||row.provider_code!==null||row.plan_sha256!==envelope.result.plan_sha256||row.request_sha256!==entry.request_sha256||
            row.token_sha256!==entry.token_sha256||row.provider_generation!==plan.provider_generation)throw new ApiError(409,'queue_notification_local_history_unresolved');
    }
    for(const entry of plan.attempts){
        const device=await currentDevice(ctx,job,entry);
        if(!device)throw new ApiError(409,'queue_notification_device_changed');
        if(await digest(JSON.stringify(dispatch(job,device,plan)))!==entry.request_sha256)throw new ApiError(409,'queue_notification_payload_changed');
    }
    // Global control revision changes for unrelated accounts. Only immutable
    // plan/entry identities and this notification's exact unsent states bind
    // the operator preview; the independent gateway rechecks every start.
    return {protocol:'lovelies-notification-queue-repair-v1',plan_sha256:envelope.result.plan_sha256,plan,receipts:envelope.result.receipts};
}
/** First obtain the complete independent roster. Application rows can be
 * restored/missing; their absence is never the evidence permitting a new send. */
export async function processPushRosterJob(ctx:AppContext,job:Job,permitted:()=>Promise<boolean>):Promise<void>{
    const config=configured(ctx),subject=await subjectHash(job.account_id),path='/notifications/'+job.notification_id;
    let envelope=await rosterValue(await external(ctx,path),ctx,job.notification_id,subject);
    await saveRoster(ctx,job,envelope);
    if(await priorLegacyAttempt(ctx,job.notification_id))hold('push_legacy_history_unbound');
    let allowed=await ctx.db.transaction(async()=>{await assertJob(ctx,job);return permitted();});
    if(!envelope.result.plan&&!envelope.result.retired&&allowed){
        const prepared=await ctx.db.transaction(async()=>{
            await assertJob(ctx,job);if(!await permitted())return null;
            const existing=await ctx.db.one<{plan_json:string;plan_sha256:string}>('SELECT plan_json,plan_sha256 FROM notification_dispatch_plans WHERE notification_id=?',job.notification_id);
            if(existing){const plan=planValue(JSON.parse(existing.plan_json),ctx,job.notification_id,subject);
                if(await digest(stable(plan))!==existing.plan_sha256)hold();return plan;}
            if(envelope.control.state!=='serving'||envelope.control.provider_generation!==config.generation)hold('push_provider_generation_changed');
            const devices=await ctx.db.all<Device>(`SELECT p.* FROM push_devices p JOIN auth_devices d ON d.id=p.auth_device_id AND d.account_id=p.account_id AND d.status='active'
                WHERE p.account_id=? AND p.active=1 ORDER BY p.id LIMIT 11`,job.account_id);
            if(devices.length>10)hold('push_device_roster_capacity');
            const plan:Plan={protocol:PLAN,ledger_id:config.ledger,ledger_bootstrap_id:config.bootstrap,notification_id:job.notification_id,
                subject_sha256:subject,provider_generation:config.generation,attempts:[]};
            for(const device of devices){
                if(!UUID.test(device.id)||await digest(device.token_value)!==device.token_hash)hold('push_device_binding_changed');
                plan.attempts.push({operation_key:'notification:'+job.notification_id+':'+device.id,device_id:device.id,platform:device.platform,
                    token_sha256:device.token_hash,request_sha256:await digest(JSON.stringify(dispatch(job,device,plan)))});
            }
            await savePlan(ctx,plan,await digest(stable(plan)));return plan;
        });
        if(prepared){envelope=await rosterValue(await external(ctx,'/notifications/plan',prepared),ctx,job.notification_id,subject);await saveRoster(ctx,job,envelope);}
        else allowed=false;
    }
    if(!allowed||envelope.result.plan&&envelope.result.plan.provider_generation!==config.generation){
        envelope=await rosterValue(await external(ctx,path+'/retire',{}),ctx,job.notification_id,subject);await saveRoster(ctx,job,envelope);
    }
    if(!envelope.result.plan){
        if(!envelope.result.retired)hold();
        await ctx.db.transaction(async()=>{await assertJob(ctx,job);
            await ctx.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')",job.notification_id);});
        return;
    }
    const plan=envelope.result.plan,planHash=envelope.result.plan_sha256!;
    let failure:PushRosterHold|undefined;
    for(const receipt of envelope.result.receipts){
        if(receipt.status!=='unstarted'||envelope.result.retired)continue;
        const entry=plan.attempts.find(entry=>entry.operation_key===receipt.operation_key)!;
        try{
            const intended=await ctx.db.transaction(async()=>{
                await assertJob(ctx,job);if(!await permitted()||plan.provider_generation!==config.generation)return null;
                const device=await currentDevice(ctx,job,entry);if(!device)return null;
                const body=dispatch(job,device,plan);if(await digest(JSON.stringify(body))!==entry.request_sha256)hold('push_dispatch_binding_changed');return body;
            });
            if(!intended)continue;
            const accepted=receiptValue(await external(ctx,'/send',{protocol:'lovelies-push-send-v2',plan_sha256:planHash,dispatch:intended}),plan,planHash);
            await ctx.db.transaction(async()=>{await assertJob(ctx,job);await recordReceipt(ctx,job,plan,planHash,accepted);});
            if(!terminal.has(accepted.status))failure??=new PushRosterHold(503,'push_reconciliation_required');
        }catch(error){if(!(error instanceof PushRosterHold))throw error;failure??=error;}
    }
    // One bounded complete refresh observes every attempted device, including a
    // late acceptance whose original local device no longer exists.
    envelope=await rosterValue(await external(ctx,path),ctx,job.notification_id,subject);await saveRoster(ctx,job,envelope);
    const canRetry=await ctx.db.transaction(async()=>{
        await assertJob(ctx,job);allowed=await permitted();if(!allowed||plan.provider_generation!==config.generation)return false;
        for(const receipt of envelope.result.receipts){
            if(receipt.status==='preparing')return true;
            if(receipt.status==='unstarted'){
                const entry=plan.attempts.find(entry=>entry.operation_key===receipt.operation_key)!;
                if(await currentDevice(ctx,job,entry))return true;
            }
        }
        return false;
    });
    if(!envelope.result.retired&&!canRetry){
        envelope=await rosterValue(await external(ctx,path+'/retire',{}),ctx,job.notification_id,subject);await saveRoster(ctx,job,envelope);
    }
    const unresolved=envelope.result.receipts.some(receipt=>!terminal.has(receipt.status));
    await ctx.db.transaction(async()=>{
        await assertJob(ctx,job);
        if(unresolved||!envelope.result.retired)await ctx.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')",job.notification_id);
        else await ctx.db.run("UPDATE notification_jobs SET status=? WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')",
            envelope.result.receipts.some(receipt=>receipt.status==='accepted')?'accepted':allowed?'inbox_only':'cancelled',job.notification_id);
    });
    if(unresolved||!envelope.result.retired)throw failure??new PushRosterHold(503,'push_reconciliation_required');
}

export type PushSubjectRetirementProof={protocol:string;subject_sha256:string;ledger_id:string;ledger_bootstrap_id:string;
    plans:number;started:number;settled:number;dispatch_quiescent:true;provider_erasure_verified:false};
const issuedRetirements=new WeakMap<object,{db:Database;subject:string}>();
export async function validatePushSubjectRetirement(ctx:AppContext,subject:string,proof:PushSubjectRetirementProof|null):Promise<void>{
    if(!usesPushRoster(ctx)&&proof===null){
        if(await ctx.db.one(`SELECT p.notification_id FROM notification_dispatch_plans p JOIN notifications n ON n.id=p.notification_id WHERE n.account_id=? LIMIT 1`,subject)||
            await ctx.db.one(`SELECT r.notification_id FROM notification_recovered_receipts r JOIN notifications n ON n.id=r.notification_id WHERE n.account_id=? LIMIT 1`,subject))hold('push_roster_configuration_required');
        return;
    }
    const config=configured(ctx);
    if(!exact(proof,['protocol','subject_sha256','ledger_id','ledger_bootstrap_id','plans','started','settled','dispatch_quiescent','provider_erasure_verified'])||
        issuedRetirements.get(proof)?.db!==ctx.db||issuedRetirements.get(proof)?.subject!==subject||
        proof.protocol!==ROSTER||proof.subject_sha256!==await subjectHash(subject)||proof.ledger_id!==config.ledger||proof.ledger_bootstrap_id!==config.bootstrap||
        !integer(proof.plans)||!integer(proof.started)||proof.settled!==proof.started||proof.dispatch_quiescent!==true||proof.provider_erasure_verified!==false)
        hold('push_subject_retirement_required');
}
/** Called after approved deletion execution admission, outside its metadata
 * transaction. Retirement is permanent; it does not claim provider erasure. */
export async function retirePushSubject(ctx:AppContext,subject:string):Promise<PushSubjectRetirementProof|null>{
    if(!usesPushRoster(ctx)){
        // Compatibility for local legacy fixtures only. Production always needs
        // the independent proof, even when its restored SQL contains no rows.
        await validatePushSubjectRetirement(ctx,subject,null);
        return null;
    }
    if(ctx.db.inTransaction?.())hold('push_retirement_transaction_boundary');
    const expected=await subjectHash(subject),value=baseEnvelope(await external(ctx,'/subjects/'+expected+'/retire',{}),ctx),proof=value.result;
    if(!exact(proof,['subject_sha256','retired','plans','started','settled','unresolved','dispatch_quiescent','provider_erasure_verified'])||
        proof.subject_sha256!==expected||proof.retired!==true||['plans','started','settled','unresolved'].some(key=>!integer(proof[key]))||
        proof.settled>proof.started||proof.unresolved!==proof.started-proof.settled||proof.dispatch_quiescent!==(proof.unresolved===0)||proof.provider_erasure_verified!==false)hold();
    // Preserve old unbound evidence rather than inventing a v2 migration.
    if(await ctx.db.one(`SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.account_id=?
        AND (d.attempts>0 OR d.provider_receipt IS NOT NULL OR d.lease_token IS NOT NULL OR d.lease_until IS NOT NULL OR d.status IN('dispatching','accepted','ambiguous')) LIMIT 1`,subject))hold('push_legacy_history_unbound');
    // Reconcile a bounded, fair batch of locally unresolved rosters. Permanent
    // subject retirement already prevents any new start, including lost rows.
    const jobs=await ctx.db.transaction(async()=>{
        const rows=await ctx.db.all<Job>(`SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs j JOIN notifications n ON n.id=j.notification_id
        WHERE j.account_id=? AND EXISTS(SELECT 1 FROM notification_recovered_receipts r WHERE r.notification_id=j.notification_id AND r.status NOT IN('accepted','rejected','cancelled'))
        ORDER BY coalesce(j.last_examined_at,0),j.notification_id LIMIT 25`,subject);
        const last=await ctx.db.one<{last:number|null}>('SELECT max(last_examined_at) AS last FROM notification_jobs WHERE account_id=?',subject);
        const examined=Math.max(ctx.now(),(last?.last??0)+1);
        if(!Number.isSafeInteger(examined))hold('push_receipt_sequence_exhausted');
        for(const job of rows)await ctx.db.run('UPDATE notification_jobs SET last_examined_at=? WHERE notification_id=?',examined,job.notification_id);
        return rows;
    });
    let failure:PushRosterHold|undefined;
    for(const job of jobs)try{
        const result=await rosterValue(await external(ctx,'/notifications/'+job.notification_id),ctx,job.notification_id,expected);await saveRoster(ctx,job,result);
    }catch(error){if(!(error instanceof PushRosterHold))throw error;failure??=error;}
    if(failure)throw failure;
    if(proof.unresolved!==0)hold('push_subject_reconciliation_required');
    const issued:PushSubjectRetirementProof=Object.freeze({protocol:ROSTER,subject_sha256:expected,ledger_id:value.ledger_id,ledger_bootstrap_id:value.ledger_bootstrap_id,
        plans:proof.plans,started:proof.started,settled:proof.settled,dispatch_quiescent:true,provider_erasure_verified:false});
    issuedRetirements.set(issued,{db:ctx.db,subject});return issued;
}
export async function assertNotificationEvidenceErasable(db:Database,subject:string):Promise<void>{
    if(await db.one(`SELECT r.operation_key FROM notification_recovered_receipts r JOIN notifications n ON n.id=r.notification_id
        WHERE n.account_id=? AND r.status NOT IN('accepted','rejected','cancelled') LIMIT 1`,subject))hold('push_subject_reconciliation_required');
    if(await db.one(`SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN push_devices p ON p.id=d.device_id
        WHERE (n.account_id=? OR p.account_id=?) AND d.status<>'accepted'
        AND (d.attempts>0 OR d.provider_receipt IS NOT NULL OR d.lease_token IS NOT NULL OR d.lease_until IS NOT NULL OR d.status IN('dispatching','ambiguous')) LIMIT 1`,subject,subject))hold('push_subject_reconciliation_required');
}
