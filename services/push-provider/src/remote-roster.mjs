import {PUSH_LEDGER_PROJECT,validateOutcome} from './durable-ledger.mjs';
import {ROSTER_BODY_LIMIT,ROSTER_REPLY_LIMIT} from './roster-ledger.mjs';
import {canonical,exact,HASH,UUID,sha256,validatePlan,PUSH_ROSTER_PROTOCOL,PUSH_RECEIPT_V2} from './push-plan.mjs';

export class RosterUnavailable extends Error {
  constructor(code='provider_roster_unavailable',status=503){super(code);this.code=code;this.status=status;}
}
const unavailable=()=>{throw new RosterUnavailable();};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const errors=new Set(['operation_payload_conflict','push_roster_binding_conflict','push_provider_generation_changed','push_plan_retired',
  'push_subject_retired','push_roster_quarantined','push_generation_reconciliation_required','push_generation_reuse_denied','push_terminal_outcome_conflict']);
export function validateRosterControl(value){
  if(!exact(value,['provider_generation','state','reason','revision','plans','attempts','started','settled','retired_subjects'])||
    !HASH.test(value.provider_generation)||!['serving','quarantined'].includes(value.state)||
    value.state==='serving'&&value.reason!==null||value.state==='quarantined'&&!['ledger_recovery_required','provider_generation_retirement','storage_integrity_unconfirmed'].includes(value.reason)||
    ['revision','plans','attempts','started','settled','retired_subjects'].some(key=>!integer(value[key]))||value.settled>value.started||value.started>value.attempts)unavailable();
  return value;
}
export function validateRosterReceipt(value,plan,planHash){
  const required=['protocol','operation_key','notification_id','plan_sha256','provider_generation','request_sha256','token_sha256','provider_request_id','status'];
  const extra=['provider_message_id','provider_code','retryable','token_invalid'];
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...extra].includes(key))||
    value.protocol!==PUSH_RECEIPT_V2||value.notification_id!==plan.notification_id||value.plan_sha256!==planHash||value.provider_generation!==plan.provider_generation||
    !UUID.test(value.provider_request_id)||!['unstarted','preparing','dispatching','accepted','rejected','ambiguous','cancelled'].includes(value.status))unavailable();
  const entry=plan.attempts.find(entry=>entry.operation_key===value.operation_key);
  if(!entry||value.request_sha256!==entry.request_sha256||value.token_sha256!==entry.token_sha256)unavailable();
  if(['accepted','rejected'].includes(value.status)){
    try{const outcome=validateOutcome(Object.fromEntries(['status',...extra].map(key=>[key,value[key]])));
      if(canonical(outcome)!==canonical(Object.fromEntries(['status',...extra].map(key=>[key,value[key]]))))unavailable();}
    catch{unavailable();}
  }else if(extra.some(key=>Object.hasOwn(value,key)))unavailable();
  return value;
}
export async function validateRoster(value,notificationID,ledgerID,bootstrapID){
  if(!exact(value,['plan','plan_sha256','retired','receipts'])||typeof value.retired!=='boolean'||!Array.isArray(value.receipts))unavailable();
  if(value.plan===null){if(value.plan_sha256!==null||value.receipts.length!==0)unavailable();return value;}
  let plan;try{plan=validatePlan(value.plan);}catch{unavailable();}
  if(plan.notification_id!==notificationID||plan.ledger_id!==ledgerID||plan.ledger_bootstrap_id!==bootstrapID||
    value.plan_sha256!==await sha256(canonical(plan))||value.receipts.length!==plan.attempts.length)unavailable();
  for(let index=0;index<value.receipts.length;index++){
    validateRosterReceipt(value.receipts[index],plan,value.plan_sha256);
    if(value.receipts[index].operation_key!==plan.attempts[index].operation_key)unavailable();
  }
  return value;
}
/** No retries around independent mutations. Missing or stale envelopes cannot
 * mint an empty history; every response carries the configured bootstrap pin. */
export class RemoteRosterLedger {
  #origin;#token;#id;#bootstrap;#fetch;#timeout;
  constructor(url,token,{ledgerID,bootstrapID,fetcher=fetch,timeoutMs=15000}={}){
    let parsed;try{parsed=new URL(url);}catch{unavailable();}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||
      !UUID.test(ledgerID)||!UUID.test(bootstrapID)||typeof token!=='string'||!/^[!-~]{32,256}$/.test(token)||
      typeof fetcher!=='function'||!integer(timeoutMs,1)||timeoutMs>30000)unavailable();
    this.#origin=parsed.origin;this.#token=token;this.#id=ledgerID;this.#bootstrap=bootstrapID;this.#fetch=fetcher;this.#timeout=timeoutMs;
  }
  async #request(path,fields){
    const controller=new AbortController();let timer,reader,response,done=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(new RosterUnavailable());},this.#timeout);});
    const task=async()=>{
      const body=fields===undefined?undefined:JSON.stringify({version:2,project_id:PUSH_LEDGER_PROJECT,ledger_id:this.#id,...fields});
      if(body!==undefined&&Buffer.byteLength(body)>ROSTER_BODY_LIMIT)unavailable();
      response=await this.#fetch(this.#origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.#token,
        accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body}),redirect:'error',signal:controller.signal});
      if(controller.signal.aborted||response.redirected||response.url&&response.url!==this.#origin+path||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||response.headers.has('content-encoding'))unavailable();
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>ROSTER_REPLY_LIMIT))unavailable();
      reader=response.body?.getReader();if(!reader)unavailable();const chunks=[];let size=0;
      try{for(;;){const item=await reader.read();if(item.done){done=true;break;}size+=item.value.byteLength;
          if(size>ROSTER_REPLY_LIMIT||controller.signal.aborted)unavailable();chunks.push(item.value);}
        if(length!==null&&Number(length)!==size||controller.signal.aborted)unavailable();
        const bytes=Buffer.concat(chunks);let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
        if(response.status!==200){if([409,503].includes(response.status)&&exact(value,['error'])&&errors.has(value.error))throw new RosterUnavailable(value.error,response.status);unavailable();}
        if(!exact(value,['protocol','project_id','ledger_id','ledger_bootstrap_id','control',...(Object.hasOwn(value,'result')?['result']:[])])||
          value.protocol!==PUSH_ROSTER_PROTOCOL||value.project_id!==PUSH_LEDGER_PROJECT||value.ledger_id!==this.#id||value.ledger_bootstrap_id!==this.#bootstrap)unavailable();
        validateRosterControl(value.control);return value;
      }finally{for(const chunk of chunks)chunk.fill(0);}
    };
    try{return await Promise.race([task(),timeout]);}
    catch(error){if(error instanceof RosterUnavailable)throw error;unavailable();}
    finally{clearTimeout(timer);if(!done){controller.abort();void(reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}}
  }
  async control(){return this.#request('/v2/control');}
  async plan(plan){const checked=validatePlan(plan),digest=await sha256(canonical(checked));
    const result=await this.#request('/v2/plans',{plan:checked,plan_sha256:digest});
    await validateRoster(result.result,checked.notification_id,this.#id,this.#bootstrap);
    if(result.result.plan_sha256!==digest)unavailable();return result;
  }
  async lookupPlan(id){if(!UUID.test(id))unavailable();const result=await this.#request('/v2/plans/'+id);
    await validateRoster(result.result,id,this.#id,this.#bootstrap);return result;}
  async retirePlan(id){if(!UUID.test(id))unavailable();const result=await this.#request('/v2/plans/'+id+'/retire',{});
    await validateRoster(result.result,id,this.#id,this.#bootstrap);if(!result.result.retired)unavailable();return result;}
  async retireSubject(subject){if(!HASH.test(subject))unavailable();const result=await this.#request('/v2/subjects/'+subject+'/retire',{});
    const p=result.result;
    if(!exact(p,['subject_sha256','retired','plans','started','settled','unresolved','dispatch_quiescent','provider_erasure_verified'])||p.subject_sha256!==subject||p.retired!==true||
      ['plans','started','settled','unresolved'].some(key=>!integer(p[key]))||p.settled>p.started||p.unresolved!==p.started-p.settled||
      p.dispatch_quiescent!==(p.unresolved===0)||p.provider_erasure_verified!==false)unavailable();return result;}
  async listPlans(after=''){if(after&&!UUID.test(after))unavailable();const result=await this.#request('/v2/plans/page/'+(after||'0'));
    if(!exact(result.result,['items','next_cursor'])||!Array.isArray(result.result.items)||result.result.items.length>25)unavailable();
    let previous=after;for(const item of result.result.items){if(!exact(item,['notification_id','subject_sha256','provider_generation','plan_sha256'])||
      !UUID.test(item.notification_id)||item.notification_id<=previous||!HASH.test(item.subject_sha256)||!HASH.test(item.provider_generation)||!HASH.test(item.plan_sha256))unavailable();previous=item.notification_id;}
    if(result.result.next_cursor!==null&&(result.result.items.length!==25||result.result.next_cursor!==previous))unavailable();return result;}
  async reserve(dispatch,planHash){const result=await this.#request('/v2/operations/reserve',{operation_key:dispatch.operation_key,plan_sha256:planHash,
      request_sha256:await sha256(JSON.stringify(dispatch)),provider_generation:dispatch.provider_generation});
    if(!exact(result.result,['receipt','claim'])||result.result.claim!==null&&!UUID.test(result.result.claim))unavailable();return result.result;}
  async preflightFailed(key,claim){return this.#request('/v2/operations/'+encodeURIComponent(key)+'/preflight-failed',{claim_id:claim,code:'provider_preflight_unavailable'});}
  async start(key,claim,generation){const result=await this.#request('/v2/operations/'+encodeURIComponent(key)+'/start',{claim_id:claim,provider_generation:generation});
    if(!exact(result.result,['receipt']))unavailable();return result.result.receipt;}
  async finish(key,outcome){const result=await this.#request('/v2/operations/'+encodeURIComponent(key)+'/finish',{result:validateOutcome(outcome)});
    if(!exact(result.result,['receipt']))unavailable();return result.result.receipt;}
  async lookup(key){
    const match=/^notification:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(key);
    if(!match||!UUID.test(match[1])||!UUID.test(match[2]))unavailable();
    const result=await this.lookupPlan(match[1]),receipt=result.result.receipts.find(entry=>entry.operation_key===key);
    if(!receipt)unavailable();return receipt;
  }
}
