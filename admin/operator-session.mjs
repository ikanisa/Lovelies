import {AUDIENCE_POLICY,AUDIENCE_DEVICE_PROTOCOL,audienceDecision,audienceDecisionFields,audienceProjection,
  audienceDeviceStatus,audienceRenewalReceipt,audienceChallenge} from './audience.mjs';
import {operatorCapabilities} from '../clients/backend/operator-capabilities.mjs';
import { canonical, faceChallenge, faceSigningBytes, faceCapturePayload, faceCompletionPayload,
  faceCaptureDigest, toBase64url, publicDeviceKey } from '../clients/backend/face-contracts.mjs';

const fail = (code, status = 0) => { throw Object.assign(new Error(code), {code,status}); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const productDenials=new Set(['audience_required','audience_review_required','age_not_supported','guardian_approval_required','audience_restricted','registered_face_required','admin_required','operator_capability_required']);
const productDenied=(status,code)=>(status===403&&productDenials.has(code))||(status===401&&code==='registered_face_session_invalid');
const terminalRecovery=error=>(error.status===409&&error.code==='operation_recovered_without_result')||(error.status===410&&error.code==='operation_retired_by_recovery');
const retainAction=error=>error.status===401||(error.status===403&&(productDenials.has(error.code)||['fresh_face_authentication_required','guardian_adult_required'].includes(error.code)));
export function apiBase(value) {
  const url = new URL(value), loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash ||
      !['','/','/functions/v1/lovelies-api','/functions/v1/lovelies-api/'].includes(url.pathname)) fail('invalid_api_origin');
  return url.href.replace(/\/$/, '');
}
export function operationBody(action, row, reason, key) {
  if (!uuid(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !uuid(key) ||
      typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) fail('invalid_review');
  return {action, expected_revision:row.revision, reason:reason.trim(), operation_key:key};
}
async function boundedJson(response) {
  if (!response.body) fail('invalid_response');
  const reader = response.body.getReader(), parts=[]; let size=0;
  try { for (;;) { const next=await reader.read(); if(next.done) break; size+=next.value.length;
    if(size>2*1024*1024) { await reader.cancel(); fail('response_too_large'); } parts.push(next.value); }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('invalid_response'); }
}

/** Non-extractable WebCrypto device/encryption keys stay in this browser's
 * IndexedDB. This is browser key storage, not hardware/secure-enclave attestation. */
export class OperatorVault {
  constructor(base, indexedDB = globalThis.indexedDB) { this.base=apiBase(base); this.indexedDB=indexedDB; }
  async database() {
    if(!this.indexedDB || !globalThis.crypto?.subtle) fail('private_storage_unavailable');
    if(!this.db) this.db=await new Promise((resolve,reject)=>{
      const request=this.indexedDB.open('lovelies-operator-device-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('records');
      request.onerror=()=>reject(Object.assign(new Error('private_storage_unavailable'),{code:'private_storage_unavailable'}));
      request.onsuccess=()=>resolve(request.result);
      request.onblocked=()=>reject(Object.assign(new Error('private_storage_blocked'),{code:'private_storage_blocked'}));
    }); return this.db;
  }
  async load() {
    const db=await this.database();const record=await new Promise((resolve,reject)=>{
      const request=db.transaction('records').objectStore('records').get(this.base);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    if(!record) return null;
    if(!record.encryptionKey || !record.signingKey || record.signingKey.extractable || record.encryptionKey.extractable) fail('private_key_unavailable');
    try {
      const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:new TextEncoder().encode(this.base)},record.encryptionKey,record.sealed);
      const value=JSON.parse(new TextDecoder().decode(plain));
      this.keys={signingKey:record.signingKey,encryptionKey:record.encryptionKey};
      this.revision=record.revision??0;this.loadedExisting=true;
      return value;
    } catch { fail('private_state_unavailable'); }
  }
  async create() {
    if(this.creating)fail('device_creation_in_progress');this.creating=true;
    try {
    if(this.keys || await this.load()) fail('existing_device_must_recover');
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    const keys={signingKey:pair.privateKey,encryptionKey:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};
    const exported=await crypto.subtle.exportKey('jwk',pair.publicKey);
    const jwk=publicDeviceKey({kty:'EC',crv:'P-256',x:exported.x,y:exported.y,ext:true,key_ops:['verify']});
    const value={version:1,base:this.base,devicePublicJwk:jwk,reference:null,enrollment:null,anonymous:null,pendingAudience:null,pendingAction:null};
    await this.save(value,{initialKeys:keys});return value;
    }finally{this.creating=false;}
  }
  async save(value,{initialKeys}={}) {
    const keys=initialKeys??this.keys;
    if(!keys || value.base!==this.base) fail('private_state_scope_changed');
    const expected=initialKeys?0:this.revision??0,loadedExisting=initialKeys?false:this.loadedExisting;
    const iv=crypto.getRandomValues(new Uint8Array(12)), plaintext=new TextEncoder().encode(JSON.stringify(value));
    let sealed;try{sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(this.base)},keys.encryptionKey,plaintext);}finally{plaintext.fill(0);}
    const db=await this.database();
    await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite'),records=tx.objectStore('records');let conflict=false;
      const prior=records.get(this.base);prior.onsuccess=()=>{
        if((prior.result?.revision??0)!==expected || (prior.result&&!loadedExisting&&expected===0) || (!prior.result&&expected!==0)){
          conflict=true;tx.abort();return;
        }
        records.put({...keys,iv,sealed,revision:expected+1},this.base);
      };
      tx.oncomplete=()=>{this.keys=keys;this.revision=expected+1;this.loadedExisting=true;resolve();};
      tx.onabort=()=>reject(Object.assign(new Error(conflict?'private_state_changed':'private_write_failed'),{code:conflict?'private_state_changed':'private_write_failed'}));tx.onerror=()=>{};
    });
  }
  async sign(value) {
    if(!this.keys?.signingKey) fail('private_key_unavailable');
    return toBase64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},this.keys.signingKey,faceSigningBytes(value))));
  }
}

export class OperatorSession {
  constructor({baseUrl,policyVersion,fetch=globalThis.fetch,vault,now=Date.now}) {
    this.base=apiBase(baseUrl);this.policy=policyVersion;this.fetch=fetch;this.vault=vault??new OperatorVault(this.base);this.now=now;
    this.epoch=0;this.credentials=null;this.operator=null;this.challenge=null;this.state=null;this.captures=[];this.actionOwner=null;this.audienceReview=null;this.audienceBusy=false;
  }
  check(epoch) { if(epoch!==this.epoch)fail('session_changed'); }
  captureAuthority(challenge,epoch) {
    this.check(epoch);
    if(!challenge||challenge!==this.challenge)fail('capture_scope_changed');
    if(Date.parse(challenge.expires_at)<=this.now())fail('capture_expired');
    audienceChallenge(challenge,this.now());return challenge;
  }
  async checked(work,epoch) {const value=await work;this.check(epoch);return value;}
  async proof(payload,epoch) {return this.checked(this.vault.sign(payload),epoch);}
  async keyBinding(value,epoch) {const digest=await this.checked(faceCaptureDigest(new TextEncoder().encode(canonical(this.state.devicePublicJwk))),epoch);
    if(value.public_key_digest!==digest || value.policy_version!==this.policy)fail('enrollment_scope_changed');}
  async restore() {const epoch=this.epoch; this.state=await this.checked(this.vault.load(),epoch);return {registered:!!this.state?.reference,pending:!!this.state?.enrollment}; }
  async request(path,{method='GET',body,bytes,headers={},token=this.credentials?.access_token,invalidateSessionOn401=true}={}) {
    if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\\\x00-\x1f]/.test(path))fail('invalid_api_path');
    const target=new URL(this.base+path), prefix=new URL(this.base).pathname.replace(/\/$/,'');
    if(target.origin!==new URL(this.base).origin || target.hash || target.pathname!==prefix+path.split('?')[0] || /%(?:2e|2f|5c)/i.test(path))fail('invalid_api_path');
    const epoch=this.epoch,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try {
      const response=await this.fetch(target.href,{method,body:bytes??(body==null?undefined:JSON.stringify(body)),
        headers:{accept:'application/json',...(body==null?{}:{'content-type':'application/json'}),...headers,...(token?{authorization:`Bearer ${token}`}:{})},
        credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
      const result=await boundedJson(response);
      if(epoch!==this.epoch)fail('session_changed');
      if(!response.ok) {
        const code=result.error?.code??'request_failed';
        // A strong product denial does not invalidate an otherwise current own
        // privacy/session credential. Fence concurrent product work separately.
        if(productDenied(response.status,code)){this.operator=null;this.challenge=null;this.captures=[];this.audienceReview=null;this.epoch++;}
        else if(response.status===401&&invalidateSessionOn401){this.credentials=null;this.operator=null;this.audienceReview=null;this.epoch++;}
        fail(code,response.status);
      }
      return result;
    } finally {clearTimeout(timer);}
  }
  async signed(payload) {const epoch=this.epoch;return {...payload,device_signature:await this.proof(payload,epoch)};}
  async startEnrollment(consented,selection,eligibilityConfirmed=false) {
    const epoch=this.epoch;
    if(consented!==true)fail('authentication_consent_required');
    if(eligibilityConfirmed!==true)fail('audience_confirmation_required');
    const decision=audienceDecision(selection);
    this.state??=await this.checked(this.vault.load(),epoch);this.state??=await this.checked(this.vault.create(),epoch);
    if(this.state.reference) return this.startLogin();
    if(this.state.enrollment)return this.recoverEnrollment();
    if(!this.state.anonymous){const value=await this.request('/auth/anonymous',{method:'POST',body:{},token:null});
      if(!uuid(value.account_id)||value.auth_method!=='anonymous'||typeof value.access_token!=='string')fail('auth_response_invalid');
      this.state.anonymous=value;await this.checked(this.vault.save(this.state),epoch);}
    const current=await this.declareOperatorAudience(decision);if(!current)return null;this.check(epoch);
    const journal={account_id:this.state.anonymous.account_id,enrollment_key:crypto.randomUUID(),face_handle:`lfh_${toBase64url(crypto.getRandomValues(new Uint8Array(32)))}`,
      policy_version:this.policy,device_public_jwk:this.state.devicePublicJwk,challenge:null,captures:[],resume:null};
    this.state.enrollment=journal;await this.checked(this.vault.save(this.state),epoch);return this.dispatchEnrollment();
  }
  audienceScope(kind) {
    const reference=this.state?.reference,anonymous=this.state?.anonymous;
    const scope={kind,epoch:this.epoch,accountId:kind==='device'?reference?.accountId:anonymous?.account_id,reference,
      referenceBinding:reference?canonical(reference):null,anonymous,token:anonymous?.access_token,pending:null};
    if(!uuid(scope.accountId)||(kind==='device'&&(!uuid(reference?.deviceId)||typeof reference.faceHandle!=='string'||this.credentials||this.operator))||
        (kind==='anonymous'&&(reference||this.credentials||this.operator||typeof scope.token!=='string')))fail('original_session_recovery_required');
    return scope;
  }
  checkAudienceScope(scope) {
    this.check(scope.epoch);
    if(scope.kind==='device'){
      if(this.credentials||this.operator||this.state?.reference!==scope.reference||canonical(this.state.reference)!==scope.referenceBinding)fail('private_state_scope_changed');
    }else if(this.state?.reference||this.credentials||this.operator||this.state?.anonymous!==scope.anonymous||
        this.state.anonymous?.account_id!==scope.accountId||this.state.anonymous.access_token!==scope.token)fail('private_state_scope_changed');
    if(scope.pending&&(this.state?.pendingAudience!==scope.pending||canonical(scope.pending)!==scope.pendingBinding))fail('private_state_scope_changed');
  }
  bindAudienceJournal(scope,pending) {
    const body=pending?.body,legacy=body&&Object.hasOwn(body,'age_band');
    if(pending?.accountId!==scope.accountId||!body||body.policy_version!==AUDIENCE_POLICY||!uuid(body.operation_key)||
        !Number.isSafeInteger(body.expected_version)||body.expected_version<0)fail('private_state_scope_changed');
    if(legacy){
      // A pre-upgrade uncertain intent is replayed byte for byte. It is never
      // converted into a new decision or silently assigned another key.
      if(scope.kind!=='anonymous'||pending.version!=null||pending.kind!=null||body.age_band!=='18_plus'||
          Object.keys(body).sort().join(',')!=='age_band,expected_version,operation_key,policy_version'||
          Object.keys(pending).sort().join(',')!=='accountId,body')fail('private_state_scope_changed');
    }else{
      if(pending.version!==2||!['declaration','session-renewal','device-renewal'].includes(pending.kind))fail('private_state_scope_changed');
      const journalKeys=['version','kind','accountId','body',...(pending.kind==='device-renewal'?['deviceId','faceHandle']:[])];
      if(Object.keys(pending).sort().join(',')!==journalKeys.sort().join(','))fail('private_state_scope_changed');
      audienceDecisionFields({at_least_13:body.at_least_13,guardian_required:body.guardian_required});
      const renewal=pending.kind!=='declaration',keys=['at_least_13','guardian_required','policy_version','expected_version','operation_key',...(renewal?['consent']:[])];
      if(Object.keys(body).sort().join(',')!==keys.sort().join(','))fail('private_state_scope_changed');
      // A saved operation keeps its original consent policy after configuration
      // changes. Only the server can prove whether those exact bytes committed;
      // a new operation always uses this.policy when its journal is created.
      const consent=body.consent;
      if(renewal&&(body.at_least_13!==true||body.guardian_required!==false||!consent||
          Object.keys(consent).sort().join(',')!=='granted,policy_version,purpose'||consent.purpose!=='face_authentication'||consent.granted!==true||
          typeof consent.policy_version!=='string'||!consent.policy_version||consent.policy_version.length>160||/[\x00-\x1f\x7f]/.test(consent.policy_version)))fail('private_state_scope_changed');
      if(scope.kind==='device'?(pending.kind!=='device-renewal'||pending.deviceId!==scope.reference.deviceId||pending.faceHandle!==scope.reference.faceHandle):pending.kind==='device-renewal')fail('private_state_scope_changed');
    }
    scope.pending=pending;scope.pendingBinding=canonical(pending);this.checkAudienceScope(scope);return pending;
  }
  async saveAudienceJournal(scope,pending) {
    this.checkAudienceScope(scope);if(this.state.pendingAudience)fail('reconcile_audience_operation');
    // Retain the same intent in memory before awaiting storage: a committed
    // write followed by cancellation must not make the next attempt invent a
    // replacement key. Every new-format retry confirms durability again.
    this.state.pendingAudience=pending;this.bindAudienceJournal(scope,pending);
    await this.persistAudienceJournal(scope);return pending;
  }
  async persistAudienceJournal(scope) {
    this.checkAudienceScope(scope);await this.checked(this.vault.save(this.state),scope.epoch);this.checkAudienceScope(scope);
  }
  async finishAudienceJournal(scope,current,receipt=null) {
    this.checkAudienceScope(scope);
    const recovery=scope.kind==='device'&&current.nextStep==='profile_recovery'?{
      accountId:scope.accountId,deviceId:scope.reference.deviceId,faceHandle:scope.reference.faceHandle,
      operationKey:receipt.operationKey,version:current.version,nextStep:'profile_recovery'}:null;
    const candidate={...this.state,pendingAudience:null,...(this.state.audienceTerminal?{audienceTerminal:{...this.state.audienceTerminal,reconciledAt:this.now(),reconciledVersion:current.version,reconciledOperationKey:scope.pending.body.operation_key}}:{}),...(scope.kind==='device'?{audienceRecovery:recovery}:{})};
    await this.checked(this.vault.save(candidate),scope.epoch);this.checkAudienceScope(scope);
    this.state=candidate;scope.pending=null;this.audienceReview=null;
  }
  async retireAudienceJournal(scope,error) {
    this.checkAudienceScope(scope);
    const pending=this.state.pendingAudience,inputHash=await this.checked(faceCaptureDigest(new TextEncoder().encode(canonical(pending.body))),scope.epoch);
    this.checkAudienceScope(scope);
    const before=canonical(this.state),candidate=JSON.parse(before);candidate.pendingAudience=null;
    candidate.audienceTerminal={version:1,accountId:scope.accountId,kind:pending.kind,operationKey:pending.body.operation_key,
      inputSha256:inputHash,status:error.status,code:error.code,observedAt:this.now()};
    await this.checked(this.vault.save(candidate),scope.epoch);this.checkAudienceScope(scope);
    if(canonical(this.state)!==before)fail('private_state_changed');
    this.state=candidate;scope.pending=null;this.audienceReview=null;
  }
  async audienceDispatch(scope,work) {
    try{return await work();}
    catch(error){if(terminalRecovery(error))await this.retireAudienceJournal(scope,error);throw error;}
  }
  async sendSessionAudience(scope,options={}) {
    const path=options.path??'/me/audience',{path:ignored,...requestOptions}=options;
    const request=async()=>{this.checkAudienceScope(scope);const value=await this.request(path,{...requestOptions,token:scope.token,invalidateSessionOn401:false});this.checkAudienceScope(scope);return value;};
    try{return await request();}catch(error){
      if(error.status!==401)throw error;
      this.checkAudienceScope(scope);const refreshed=await this.refreshAnonymous();this.check(scope.epoch);
      if(this.state?.anonymous!==refreshed||refreshed?.account_id!==scope.accountId)fail('private_state_scope_changed');
      scope.anonymous=refreshed;scope.token=refreshed.access_token;this.checkAudienceScope(scope);return request();
    }
  }
  async declareOperatorAudience(decision=null,{renewal=false,consented=false,review=null}={}) {
    if(this.audienceBusy)fail('audience_operation_in_progress');this.audienceBusy=true;
    try{
      if(decision)decision=audienceDecisionFields(decision);
      const scope=this.audienceScope('anonymous');let pending=this.state.pendingAudience;
      if(pending){
        this.bindAudienceJournal(scope,pending);
        const original=pending.body.age_band?audienceDecision(pending.body.age_band):{at_least_13:pending.body.at_least_13,guardian_required:pending.body.guardian_required};
        if(decision&&canonical(original)!==canonical(decision))fail('reconcile_audience_operation');
        if(pending.version===2)await this.persistAudienceJournal(scope);
      }else{
        const current=audienceProjection(await this.sendSessionAudience(scope),scope.accountId,this.now());
        if(renewal){
          if(!review||review!==this.audienceReview||review.epoch!==scope.epoch||review.current.version!==current.version||review.current.accountId!==scope.accountId)fail('audience_record_changed');
          if(!current.reviewRequired||current.atLeast13!==true||current.guardianRequired!==false)fail('operator_adult_required');
          if(!decision||decision.at_least_13!==true||decision.guardian_required!==false)fail('operator_adult_required');
          if(consented!==true)fail('authentication_consent_required');
        }else if(current.reviewRequired){
          this.checkAudienceScope(scope);this.audienceReview={kind:'anonymous',epoch:scope.epoch,current,
            renewalAvailable:current.atLeast13===true&&current.guardianRequired===false};return null;
        }else if(current.atLeast13===true&&current.guardianRequired===false&&current.status==='eligible'&&current.capabilities.face_authentication&&
            (!decision||(decision.at_least_13===true&&decision.guardian_required===false)))return current;
        if(!decision)fail(current.version===0?'audience_selection_required':'operator_adult_required');
        const body={...decision,policy_version:AUDIENCE_POLICY,expected_version:current.version,operation_key:crypto.randomUUID(),
          ...(renewal?{consent:{purpose:'face_authentication',policy_version:this.policy,granted:true}}:{})};
        pending=await this.saveAudienceJournal(scope,{version:2,kind:renewal?'session-renewal':'declaration',accountId:scope.accountId,body});
      }
      const renewing=pending.kind==='session-renewal';
      const value=await this.audienceDispatch(scope,()=>this.sendSessionAudience(scope,{path:renewing?'/me/audience/renew':'/me/audience',method:renewing?'POST':'PUT',body:pending.body}));
      const current=audienceProjection(value,scope.accountId,this.now());
      const receipt=renewing?audienceRenewalReceipt(value,pending.body,current.version):null;
      await this.finishAudienceJournal(scope,current,receipt);
      if(current.atLeast13===true&&current.guardianRequired===false&&current.reviewRequired){
        this.audienceReview={kind:'anonymous',epoch:scope.epoch,current,renewalAvailable:true};return null;
      }
      if(current.atLeast13!==true||current.guardianRequired!==false||current.status!=='eligible'||current.reviewRequired||!current.capabilities.face_authentication)fail('operator_adult_required');
      return current;
    }finally{this.audienceBusy=false;}
  }
  async deviceAudience(scope,step,decisionBody=null) {
    this.checkAudienceScope(scope);
    const common={account_id:scope.accountId,device_id:scope.reference.deviceId,face_handle:scope.reference.faceHandle,
      request_nonce:crypto.randomUUID(),request_expires_at:this.now()+45000};
    const body={...common,...(decisionBody??{})},proof={protocol:AUDIENCE_DEVICE_PROTOCOL,step,...body};
    const signature=await this.proof(proof,scope.epoch);this.checkAudienceScope(scope);
    if(common.request_expires_at<=this.now())fail('audience_device_request_expired');
    const value=await this.request('/auth/face/audience/'+step,{method:'POST',token:null,body:{...body,device_signature:signature}});
    this.checkAudienceScope(scope);if(common.request_expires_at<=this.now())fail('audience_device_request_expired');
    const current=audienceDeviceStatus(value,{accountId:scope.accountId,deviceId:scope.reference.deviceId,requestNonce:common.request_nonce},this.now());
    return {value,current};
  }
  async renewOperatorAudience(selection,confirmed=false,consented=false) {
    const pending=this.state?.pendingAudience,review=this.audienceReview;
    if(!pending){
      if(confirmed!==true)fail('audience_confirmation_required');
      if(consented!==true)fail('authentication_consent_required');
      const decision=audienceDecision(selection);if(!decision.at_least_13||decision.guardian_required)fail('operator_adult_required');
      if(!review||review.epoch!==this.epoch||!review.current?.reviewRequired||!review.renewalAvailable)fail('audience_review_required');
      if(review.kind==='anonymous')return this.declareOperatorAudience(decision,{renewal:true,consented:true,review});
    }
    if(this.audienceBusy)fail('audience_operation_in_progress');this.audienceBusy=true;
    try{
      const scope=this.audienceScope('device');
      if(pending){this.bindAudienceJournal(scope,pending);await this.persistAudienceJournal(scope);}
      else{
        if(review.kind!=='device'||review.current.accountId!==scope.accountId||review.reference!==scope.reference||review.referenceBinding!==scope.referenceBinding)fail('private_state_scope_changed');
        const body={at_least_13:true,guardian_required:false,policy_version:AUDIENCE_POLICY,expected_version:review.current.version,operation_key:crypto.randomUUID(),
          consent:{purpose:'face_authentication',policy_version:this.policy,granted:true}};
        await this.saveAudienceJournal(scope,{version:2,kind:'device-renewal',accountId:scope.accountId,deviceId:scope.reference.deviceId,faceHandle:scope.reference.faceHandle,body});
      }
      const {value,current}=await this.audienceDispatch(scope,()=>this.deviceAudience(scope,'renew',scope.pending.body)),receipt=audienceRenewalReceipt(value,scope.pending.body,current.version);
      await this.finishAudienceJournal(scope,current,receipt);
      if(current.nextStep==='profile_recovery')this.audienceReview={kind:'profile-recovery',epoch:scope.epoch,current};
      else if(current.reviewRequired)this.audienceReview={kind:'device',epoch:scope.epoch,current,renewalAvailable:current.renewalAvailable,
        reference:scope.reference,referenceBinding:scope.referenceBinding};
      return current;
    }finally{this.audienceBusy=false;}
  }
  async recoverOperatorAudience() {
    if(!this.state?.pendingAudience)fail('audience_operation_missing');
    return this.state.pendingAudience.kind==='device-renewal'?this.renewOperatorAudience():this.declareOperatorAudience();
  }
  async dispatchEnrollment() {
    const epoch=this.epoch;
    const j=this.state.enrollment,proof={protocol:'lovelies-face-enrollment-device-v1',step:'start',account_id:j.account_id,enrollment_key:j.enrollment_key,
      face_handle:j.face_handle,policy_version:j.policy_version,device_public_jwk:j.device_public_jwk};
    const value=await this.request('/auth/face/registration/challenge',{method:'POST',token:this.state.anonymous?.access_token,
      body:{account_id:j.account_id,enrollment_key:j.enrollment_key,face_handle:j.face_handle,device_public_jwk:j.device_public_jwk,
        consent:{purpose:'face_authentication',policy_version:j.policy_version,granted:true},device_signature:await this.proof(proof,epoch)}});
    await this.keyBinding(value,epoch);
    this.challenge=faceChallenge(audienceChallenge(value,this.now()),{purpose:'registration',accountId:j.account_id},this.now());
    if(value.enrollment_key!==j.enrollment_key||value.face_handle!==j.face_handle)fail('enrollment_scope_changed');
    j.challenge=value;await this.checked(this.vault.save(this.state),epoch);this.captures=[];return this.challenge;
  }
  async recoverEnrollment() {
    const epoch=this.epoch;
    const j=this.state.enrollment,proof={protocol:'lovelies-face-enrollment-device-v1',step:'status',account_id:j.account_id,enrollment_key:j.enrollment_key,
      face_handle:j.face_handle,request_nonce:crypto.randomUUID(),request_expires_at:this.now()+45000};
    let value;try{value=await this.request('/auth/face/registration/recovery',{method:'POST',token:this.state.anonymous?.access_token,
      body:{account_id:j.account_id,enrollment_key:j.enrollment_key,face_handle:j.face_handle,request_nonce:proof.request_nonce,request_expires_at:proof.request_expires_at,device_signature:await this.proof(proof,epoch)}});
    }catch(error){if(error.code==='enrollment_not_found')return this.dispatchEnrollment();throw error;}
    await this.keyBinding(value,epoch);
    if(value.account_id!==j.account_id||value.enrollment_key!==j.enrollment_key||value.request_nonce!==proof.request_nonce)fail('enrollment_scope_changed');
    if(value.state==='registered') {
      if(!uuid(value.device_id)||!uuid(value.profile?.id)||typeof value.profile.revision!=='string'||typeof value.profile.model_id!=='string')fail('enrollment_scope_changed');
      this.state.reference={accountId:j.account_id,faceHandle:j.face_handle,deviceId:value.device_id,profileId:value.profile.id,profileRevision:value.profile.revision,modelId:value.profile.model_id};
      this.state.enrollment=null;this.state.anonymous=null;await this.checked(this.vault.save(this.state),epoch);return this.startLogin();
    }
    if(['capture_pending','verifying'].includes(value.state))fail('enrollment_waiting_for_server');
    if(value.state==='restart_required')fail('enrollment_restart_required');
    if(value.state!=='pending'||!value.challenge||!Array.isArray(value.captures))fail('enrollment_recovery_unavailable');
    this.challenge=faceChallenge(audienceChallenge({...value.challenge,face_handle:j.face_handle},this.now()),{purpose:'registration',accountId:j.account_id},this.now());
    for(const row of value.captures){const planned=j.captures.find(item=>item.index===row.index);if(!planned||canonical(planned)!==canonical(row))fail('enrollment_capture_changed');}
    j.challenge={...value.challenge,face_handle:j.face_handle,enrollment_generation:value.enrollment_generation};this.captures=value.captures;await this.checked(this.vault.save(this.state),epoch);return this.challenge;
  }
  async refreshAnonymous() {
    const epoch=this.epoch,account=this.state?.enrollment?.account_id??this.state?.anonymous?.account_id;
    if(!account||this.state.anonymous?.account_id!==account)fail('original_session_recovery_required');
    for(let attempt=0;attempt<2;attempt++){
      let journal=this.state.refreshDelivery;
      if(!journal){
        if(!this.state.anonymous.refresh_token)fail('original_session_recovery_required');
        journal={protocol:'lovelies-refresh-delivery-v1',rotation_key:crypto.randomUUID(),delivery_secret:toBase64url(crypto.getRandomValues(new Uint8Array(32))),
          refresh_token:this.state.anonymous.refresh_token,account_id:account};
        this.state.refreshDelivery=journal;await this.checked(this.vault.save(this.state),epoch);
      }
      if(journal.retired||journal.protocol!=='lovelies-refresh-delivery-v1'||journal.account_id!==account||!uuid(journal.rotation_key)||
          !/^[A-Za-z0-9_-]{43}$/.test(journal.delivery_secret)||journal.refresh_token!==this.state.anonymous.refresh_token)fail('refresh_delivery_scope_changed');
      const {account_id,...body}=journal;
      const value=await this.request('/auth/session/refresh',{method:'POST',token:null,body});
      const access=Date.parse(value.access_expires_at),refresh=Date.parse(value.refresh_expires_at),delivery=Date.parse(value.delivery_expires_at);
      if(value.protocol!==journal.protocol||value.rotation_key!==journal.rotation_key||value.account_id!==account||value.auth_method!=='anonymous'||
          typeof value.access_token!=='string'||typeof value.refresh_token!=='string'||!Number.isFinite(access)||!Number.isFinite(refresh)||!Number.isFinite(delivery)||
          refresh<=this.now()||delivery<=this.now()||access>refresh)fail('refresh_delivery_scope_changed');
      // Credentials and removal of the original delivery intent commit together.
      // Never recompute replayed access expiry from the relative expires_in.
      this.check(epoch);const candidate={...this.state,anonymous:value,refreshDelivery:null};
      await this.checked(this.vault.save(candidate),epoch);this.state=candidate;
      if(access>this.now()+30000)return value;
    }
    fail('original_session_recovery_required');
  }
  async restartEnrollment() {
    const epoch=this.epoch;
    const j=this.state?.enrollment;if(!j?.challenge)fail('enrollment_recovery_required');
    j.resume??={resume_key:crypto.randomUUID(),expected_generation:j.challenge.enrollment_generation,expected_challenge_id:j.challenge.challenge_id};
    await this.checked(this.vault.save(this.state),epoch);
    // The successor challenge is bound to this refreshed session. Replay the
    // original resume operation with that same session after a lost reply.
    if(!j.resume.session_prepared){
      await this.refreshAnonymous();j.resume.session_prepared=true;await this.checked(this.vault.save(this.state),epoch);
    }
    const {resume_key,expected_generation,expected_challenge_id}=j.resume;
    const proof={protocol:'lovelies-face-enrollment-device-v1',step:'resume',account_id:j.account_id,enrollment_key:j.enrollment_key,face_handle:j.face_handle,
      request_nonce:crypto.randomUUID(),request_expires_at:this.now()+45000,resume_key,expected_generation,expected_challenge_id};
    const {protocol,step,...body}=proof;
    const value=await this.request('/auth/face/registration/resume',{method:'POST',token:this.state.anonymous.access_token,body:{...body,device_signature:await this.proof(proof,epoch)}});
    await this.keyBinding(value,epoch);
    this.challenge=faceChallenge(audienceChallenge(value,this.now()),{purpose:'registration',accountId:j.account_id},this.now());j.challenge=value;j.captures=[];j.resume=null;this.captures=[];await this.checked(this.vault.save(this.state),epoch);return this.challenge;
  }
  async startLogin() {
    if(this.audienceBusy)fail('audience_operation_in_progress');
    const startingEpoch=this.epoch;this.state??=await this.checked(this.vault.load(),startingEpoch);const r=this.state?.reference;if(!r)fail('registered_device_required');
    this.credentials=null;this.operator=null;this.challenge=null;this.captures=[];this.audienceReview=null;this.epoch++;
    const scope=this.audienceScope('device');
    if(this.state.pendingAudience){this.bindAudienceJournal(scope,this.state.pendingAudience);return null;}
    const {current}=await this.deviceAudience(scope,'status');
    if(current.atLeast13!==true||current.guardianRequired!==false)fail('operator_adult_required');
    if(current.reviewRequired){
      this.audienceReview={kind:'device',epoch:scope.epoch,current,renewalAvailable:current.renewalAvailable,
        reference:scope.reference,referenceBinding:scope.referenceBinding};return null;
    }
    if(current.status!=='eligible')fail('operator_adult_required');
    if(current.nextStep!=='face_login'){
      this.audienceReview={kind:'profile-recovery',epoch:scope.epoch,current};return null;
    }
    const value=await this.request('/auth/face/challenge',{method:'POST',token:null,body:{face_handle:r.faceHandle,device_id:r.deviceId}});
    this.checkAudienceScope(scope);
    const challenge=faceChallenge(audienceChallenge(value,this.now()),{purpose:'login',accountId:r.accountId,deviceId:r.deviceId},this.now());
    if(challenge.audience_authority.audience_version!==current.version||Date.parse(challenge.audience_authority.expires_at)>current.authorityExpiresAt)fail('audience_challenge_invalid');
    if(value.profile_id!==r.profileId || value.profile_revision!==r.profileRevision || value.model_id!==r.modelId || value.policy_version!==this.policy)fail('registered_reference_changed');
    this.challenge=challenge;this.captures=[];return this.challenge;
  }
  async useCapture(bytes,mime='image/jpeg') {
    if(this.captureBusy)fail('capture_in_progress');this.captureBusy=true;const epoch=this.epoch;
    try {
    const c=this.challenge;if(!c)fail('capture_expired');this.captureAuthority(c,epoch);
    const index=this.captures.length;if(index>=c.required_captures)fail('capture_count');
    if(!(bytes instanceof Uint8Array)||bytes.length===0||bytes.length>c.maximum_capture_bytes ||
      this.captures.reduce((total,row)=>total+row.byte_size,0)+bytes.length>c.maximum_capture_bytes)fail('invalid_capture');
    const hash=await this.checked(faceCaptureDigest(bytes),epoch),row={index,sha256:hash,mime,byte_size:bytes.length};
    this.captureAuthority(c,epoch);
    if(this.captures.some(item=>item.sha256===hash))fail('capture_reused');
    if(c.purpose==='registration'){const j=this.state.enrollment;j.captures=j.captures.filter(item=>item.index!==index);j.captures.push(row);await this.checked(this.vault.save(this.state),epoch);}
    this.captureAuthority(c,epoch);
    const payload=faceCapturePayload(c,{index,sha256:hash,mime,byteSize:bytes.length});
    const signature=await this.proof(payload,epoch);
    this.captureAuthority(c,epoch);
    const value=await this.request(`/auth/face/proof/${c.challenge_id}/${index}`,{method:'PUT',bytes,token:c.purpose==='registration'?this.state.anonymous?.access_token:null,
      headers:{'content-type':mime,'x-lovelies-capture-sha256':hash,'x-lovelies-capture-bytes':String(bytes.length),'x-lovelies-device-signature':signature}});
    if(value.capture_index!==index||value.capture_sha256!==hash||value.byte_size!==bytes.length)fail('capture_response_changed');this.captures.push(row);return this.captures.length;
    }finally{this.captureBusy=false;}
  }
  async complete() {
    if(this.captureBusy || this.completing)fail('capture_in_progress');this.completing=true;const epoch=this.epoch;
    try {
    const c=this.challenge;if(!c||this.captures.length!==c.required_captures)fail('captures_incomplete');
    const payload=faceCompletionPayload(c,this.captures),value=await this.request(c.purpose==='registration'?'/auth/face/registration/complete':'/auth/face/complete',
      {method:'POST',token:c.purpose==='registration'?this.state.anonymous?.access_token:null,body:{challenge_id:c.challenge_id,device_signature:await this.proof(payload,epoch)}});
    if(value.status!=='authenticated'||value.auth_method!=='registered_face'||value.account_id!==c.account_id||value.device_id!==c.device_id||typeof value.access_token!=='string'||!uuid(value.profile_id))fail('auth_response_invalid');
    if(c.purpose==='registration') {const j=this.state.enrollment;this.state.reference={accountId:c.account_id,faceHandle:j.face_handle,deviceId:value.device_id,profileId:value.profile_id,profileRevision:value.profile_revision,modelId:value.model_id};
      this.state.enrollment=null;this.state.anonymous=null;await this.checked(this.vault.save(this.state),epoch);}
    this.check(epoch);this.credentials=value;this.challenge=null;this.captures=[];let me;
    try {me=await this.request('/me');
    if(me.user_id!==value.account_id||me.auth_method!=='registered_face'||me.authenticated!==true)fail('account_scope_changed');
    if(!Array.isArray(me.roles)||operatorCapabilities(me).length===0)fail('operator_provisioning_required',403);
    this.operator=me;return me;
    }catch(error){this.credentials=null;this.operator=null;throw error;}
    }finally{this.completing=false;}
  }
  async action(path,body) {
    const epoch=this.epoch,credentials=this.credentials;
    if(!this.operator)fail('operator_authentication_required');
    if(this.actionOwner)fail('operator_action_in_progress');
    // Capture the submitted intent separately from mutable form/caller objects.
    const identity=canonical({path,body,accountId:this.operator.user_id}),operation=JSON.parse(identity);
    this.state.pendingAction??=JSON.parse(identity);
    if(canonical(this.state.pendingAction)!==identity)fail('reconcile_previous_action');
    const owner={};this.actionOwner=owner;
    const current=()=>{
      this.check(epoch);
      if(this.actionOwner!==owner||this.credentials!==credentials||this.operator?.user_id!==operation.accountId)fail('session_changed');
      if(!this.state?.pendingAction||canonical(this.state.pendingAction)!==identity)fail('private_state_changed');
    };
    const clearPending=async()=>{
      current();const before=canonical(this.state),candidate=JSON.parse(before);candidate.pendingAction=null;
      // Keep the original intent visible and admission-blocking until durable
      // cleanup is acknowledged. A failed save must not admit a replacement.
      await this.checked(this.vault.save(candidate),epoch);current();
      if(canonical(this.state)!==before)fail('private_state_changed');
      this.state=candidate;
    };
    try {
      await this.checked(this.vault.save(this.state),epoch);current();
      let result;
      try {result=await this.request(operation.path,{method:'POST',body:operation.body});}
      catch(error){
        if(error.status>=400&&error.status<500&&![408,429].includes(error.status)&&!retainAction(error))await clearPending();
        throw error;
      }
      await clearPending();return result;
    }finally{if(this.actionOwner===owner)this.actionOwner=null;}
  }
  async logout() {
    const old=this.credentials,pending=this.state?.refreshDelivery;this.credentials=null;this.operator=null;this.challenge=null;this.captures=[];this.audienceReview=null;this.epoch++;
    if(pending){
      const epoch=this.epoch,enrollment=this.state.enrollment?.enrollment_key;pending.retired=true;
      const persistRetirement=async()=>{
        for(let attempt=0;attempt<2;attempt++){
          this.check(epoch);
          const latest=await this.checked(this.vault.load(),epoch),saved=latest?.refreshDelivery,anonymous=latest?.anonymous;
          // load advances this vault's CAS revision. Keep the complete state
          // paired with that revision even when a newer tab owns the attempt.
          this.state=latest;
          const sameAttempt=saved?.protocol===pending.protocol&&saved?.account_id===pending.account_id&&saved?.rotation_key===pending.rotation_key&&
            saved?.delivery_secret===pending.delivery_secret&&saved?.refresh_token===pending.refresh_token;
          const exactSuccessor=!saved&&anonymous?.protocol===pending.protocol&&anonymous?.rotation_key===pending.rotation_key;
          if(latest?.enrollment?.enrollment_key!==enrollment||anonymous?.account_id!==pending.account_id||(!sameAttempt&&!exactSuccessor))fail('private_state_changed');
          const candidate={...latest,refreshDelivery:pending};
          try{await this.checked(this.vault.save(candidate),epoch);this.state=candidate;return;}
          catch(error){
            if(error.code!=='private_state_changed'||attempt)throw error;
          }
        }
      };
      let writeError;try{await persistRetirement();}catch(error){writeError=error;}
      const {account_id,retired,cancelled,...body}=pending;
      let result;try{result=await this.request('/auth/session/refresh/cancel',{method:'POST',token:null,body});}catch(error){throw writeError??error;}
      if(result.protocol!==pending.protocol||result.rotation_key!==pending.rotation_key||result.account_id!==account_id||result.status!=='cancelled')fail('refresh_delivery_scope_changed');
      pending.cancelled=true;await persistRetirement();
    }
    if(old)await this.request('/auth/logout',{method:'POST',token:old.access_token,body:old.refresh_token?{refresh_token:old.refresh_token}:undefined});
  }
  cancelCapture() {this.epoch++;this.challenge=null;this.captures=[];this.audienceReview=null;}
}
