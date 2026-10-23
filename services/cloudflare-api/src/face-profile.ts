import { ApiError, digest, jsonBody, ok, record, stable, uuid, type AppContext } from './types';
import { authenticate, opaque, type AccountRow } from './auth';
import { assertRegisteredActor } from './operations';
import { hasConsent } from './gallery';
import { flushPrivacyCleanup } from './privacy';
import { policy, verifyKey, challengeResponse, getChallenge, captures, manifest, activeFaceVerifiers,
  type Profile, type Challenge, type Device } from './face-auth';

const PROTOCOL = 'lovelies-face-profile-v1';
const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const CONTROL_MS = 365 * 86400000;
const OPERATION_MS = 30 * 86400000;
const CHALLENGE_MS = 120000;
type Control = { account_id:string;device_id:string;control_hash:string;control_operation_key:string;creation_hash:string;
  device_revision:string;public_key_digest:string;public_jwk:string;created_at:number;expires_at:number };
type State = { account_id:string;version:number;matching_paused:number;removal_operation_key:string|null };
export type LifecycleOperation = { account_id:string;operation_key:string;action:string;input_hash:string;
  expected_version:number;control_device_id:string;control_revision:string;state:string;auth_epoch:number;
  consent_id:string|null;challenge_id:string|null;generation:number;last_resume_key:string|null;
  previous_challenge_id:string|null;previous_generation:number|null;cleanup_id:string|null;
  created_at:number;expires_at:number };
function photoPolicy(ctx:AppContext):string {
  const value=ctx.env.PHOTO_CONSENT_POLICY_VERSION ?? ctx.env.PHOTO_MODEL_VERSION;
  if(typeof value!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(value))throw new ApiError(503,'photo_policy_unavailable');
  return value;
}
function noDeletion(account:string,ctx:AppContext):void {
  if(ctx.db.one("SELECT id FROM privacy_requests WHERE subject_id=? AND request_type='delete' AND status IN('pending_approval','approved','queued','processing','failed') AND (expires_at>? OR metadata_erased_at IS NOT NULL) LIMIT 1",account,ctx.now()))
    throw new ApiError(409,'enrollment_deletion_pending');
}
function state(account:string,ctx:AppContext):State {
  ctx.db.run('INSERT OR IGNORE INTO face_profile_states(account_id,version,matching_paused) VALUES(?,1,0)',account);
  return ctx.db.one<State>('SELECT * FROM face_profile_states WHERE account_id=?',account)!;
}
function secret(value:unknown):string {
  if(typeof value!=='string'||!/^lfl_[A-Za-z0-9_-]{43}$/.test(value))throw new ApiError(400,'face_profile_control_invalid');
  return value;
}
function nonce(input:Record<string,any>,ctx:AppContext):void {
  uuid(input.request_nonce);
  if(!Number.isSafeInteger(input.request_expires_at)||input.request_expires_at<=ctx.now()||input.request_expires_at>ctx.now()+60000)
    throw new ApiError(401,'face_profile_request_expired');
}
function exact(input:Record<string,any>,additional:string[],controlCreation=false):void {
  const keys=['account_id','device_id','control_key','device_signature',...(controlCreation?[]:['request_nonce','request_expires_at']),...additional];
  if(Object.keys(input).some(k=>!keys.includes(k)))throw new ApiError(400,'face_profile_input_invalid');
}
async function inputHash(input:Record<string,any>):Promise<string> {
  const {device_signature,request_nonce,request_expires_at,...durable}=input;
  return digest(stable(durable));
}
function envelope(input:Record<string,any>,step:string):Record<string,unknown> {
  const {device_signature,...fields}=input;
  return {protocol:DEVICE_PROTOCOL,step,...fields};
}
function controlAuthority(row:Control,ctx:AppContext):Device {
  const current=ctx.db.one<Control>('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?',row.account_id,row.device_id);
  const account=ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',row.account_id);
  const device=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',row.account_id,row.device_id);
  if(!current||stable(current)!==stable(row)||current.expires_at<=ctx.now()||!account||account.disabled_at!==null||
    !device||device.status!=='active'||device.revision!==row.device_revision||device.public_jwk!==row.public_jwk||device.face_handle===null)
    throw new ApiError(401,'face_profile_control_unavailable');
  noDeletion(row.account_id,ctx);
  return device;
}
async function signed(input:Record<string,any>,step:string,ctx:AppContext):Promise<Control> {
  const account=uuid(input.account_id),deviceId=uuid(input.device_id),controlHash=await digest(secret(input.control_key));
  nonce(input,ctx);
  const row=ctx.db.one<Control>('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?',account,deviceId);
  if(!row) {
    const device=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',account,deviceId);
    const owner=ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',account);
    if(!device || device.status!=='active' || !owner || owner.disabled_at!==null)throw new ApiError(401,'face_profile_control_unavailable');
    noDeletion(account,ctx);
    await verifyKey(JSON.parse(device.public_jwk),envelope(input,step),input.device_signature);nonce(input,ctx);
    const current=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',account,deviceId);
    if(!current || stable(current)!==stable(device))throw new ApiError(401,'face_profile_control_unavailable');
    throw new ApiError(404,'face_profile_control_not_found');
  }
  if(row.control_hash!==controlHash)throw new ApiError(401,'face_profile_control_unavailable');
  const device=controlAuthority(row,ctx);
  await verifyKey(JSON.parse(device.public_jwk),envelope(input,step),input.device_signature);
  nonce(input,ctx);controlAuthority(row,ctx);
  if(await digest(device.public_jwk)!==row.public_key_digest)throw new ApiError(401,'face_profile_control_unavailable');
  nonce(input,ctx);controlAuthority(row,ctx);
  return row;
}
export function lifecycleOperation(challenge:string,ctx:AppContext):LifecycleOperation|null {
  return ctx.db.one<LifecycleOperation>('SELECT * FROM face_profile_operations WHERE challenge_id=?',challenge);
}
function operation(account:string,key:string,ctx:AppContext):LifecycleOperation|null {
  return ctx.db.one<LifecycleOperation>('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?',account,key);
}
export function lifecycleAuthority(op:LifecycleOperation,ctx:AppContext):void {
  const row=operation(op.account_id,op.operation_key,ctx);
  const control=ctx.db.one<Control>('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?',op.account_id,op.control_device_id);
  const account=ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',op.account_id);
  if(!row||!control||!account||row.state!=='pending'||row.expires_at<=ctx.now()||row.challenge_id!==op.challenge_id||
    row.generation!==op.generation||row.input_hash!==op.input_hash||row.control_revision!==control.device_revision||
    row.auth_epoch!==account.auth_epoch||row.expected_version!==state(op.account_id,ctx).version)
    throw new ApiError(409,'face_profile_operation_changed');
  controlAuthority(control,ctx);
  const c=getChallenge(op.challenge_id!,ctx);
  const p=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',op.account_id);
  if(op.action==='replace' && (!p || p.auth_enabled!==1))throw new ApiError(409,'face_profile_operation_changed');
  if(op.action==='restore_authentication' && (!p || p.auth_enabled!==0))throw new ApiError(409,'face_profile_operation_changed');
  if(c.consent_id!==op.consent_id || c.device_id!==op.control_device_id || c.device_revision!==op.control_revision)
    throw new ApiError(409,'face_profile_operation_changed');
  if(c.profile_id===null ? p!==null || op.action!=='enroll' :
    !p || p.status!=='active' || p.id!==c.profile_id || p.revision!==c.profile_revision ||
    p.model_id!==c.model_id || p.template_digest!==c.reference_digest || p.auth_epoch!==c.profile_auth_epoch)
    throw new ApiError(409,'registered_reference_changed');
  if(!ctx.db.one("SELECT id FROM consents WHERE id=? AND account_id=? AND purpose='face_authentication' AND status='granted' AND revoked_at IS NULL AND policy_version=? AND (expires_at IS NULL OR expires_at>?)",op.consent_id,op.account_id,policy(ctx),ctx.now()))
    throw new ApiError(409,'face_profile_operation_changed');
}
function cleanupState(id:string|null,account:string,ctx:AppContext):string {
  if(!id)return 'none';
  const row=ctx.db.one<{status:string}>('SELECT status FROM cleanup_intents WHERE id=? AND subject_id=?',id,account);
  if(row?.status==='verified')return 'completed';
  if(ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1',account))return 'blocked';
  return row?.status==='failed'?'failed':'pending';
}
function operationMetadata(op:LifecycleOperation,ctx:AppContext):Record<string,unknown> {
  let status=op.state,challenge:Record<string,unknown>|null=null,progress:unknown[]=[],challengeId=op.challenge_id;
  if(op.state==='pending'&&op.challenge_id) {
    const c=getChallenge(op.challenge_id,ctx);
    if(c.status==='cancelled')status='cancelled';
    else if(c.status==='failed')status='failed';
    else if(c.expires_at<=ctx.now()||c.used_at!==null)status='restart_required';
    else if(c.status==='verifying')status='verifying';
    else {
      const proof=captures(c,ctx);
      status=ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1",op.account_id)?'capture_pending':'pending';
      challenge={...challengeResponse(c),lifecycle_operation_key:op.operation_key,lifecycle_generation:op.generation};
      progress=manifest(proof);
    }
  }
  return {operation_key:op.operation_key,action:op.action,state:status,generation:op.generation,
    challenge_id:challengeId,challenge,captures:progress,cleanup_state:cleanupState(op.cleanup_id,op.account_id,ctx)};
}
export function lifecycleMetadata(account:string,deviceId:string,ctx:AppContext,op?:LifecycleOperation|null,requestNonce?:string):Record<string,unknown> {
  const s=state(account,ctx),profile=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',account);
  const device=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',account,deviceId);
  const control=ctx.db.one<Control>('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?',account,deviceId);
  const removal=s.removal_operation_key?operation(account,s.removal_operation_key,ctx):null;
  const preferences=ctx.db.one<{receive_matches:number}>('SELECT receive_matches FROM account_preferences WHERE account_id=?',account);
  return {protocol:PROTOCOL,authenticated:false,account_id:account,device_id:deviceId,
    device_revision:device?.revision,public_key_digest:control?.public_key_digest,version:s.version,
    auth_policy_version:policy(ctx),photo_policy_version:photoPolicy(ctx),
    profile:profile?.status==='active'?{id:profile.id,revision:profile.revision,model_id:profile.model_id}:null,
    authentication_enabled:profile?.status==='active'&&profile.auth_enabled===1&&!!ctx.db.one("SELECT id FROM consents WHERE id=? AND account_id=? AND purpose='face_authentication' AND status='granted' AND revoked_at IS NULL AND policy_version=? AND (expires_at IS NULL OR expires_at>?)",profile.auth_consent_id,account,policy(ctx),ctx.now()),
    matching_enabled:profile?.status==='active'&&s.matching_paused===0&&!!ctx.db.one("SELECT id FROM consents WHERE id=? AND account_id=? AND purpose='photo_matching' AND status='granted' AND revoked_at IS NULL AND policy_version=? AND (expires_at IS NULL OR expires_at>?)",profile.consent_id,account,photoPolicy(ctx),ctx.now()),
    processing_enabled:hasConsent(ctx,account,'photo_processing'),receive_matches:preferences?.receive_matches===1,
    matching_paused:s.matching_paused===1,removal_state:removal?cleanupState(removal.cleanup_id,account,ctx):'none',
    operation:op?operationMetadata(op,ctx):null,...(requestNonce?{request_nonce:requestNonce}:{})};
}
export function invalidateRecipientProfile(account:string,ctx:AppContext):void {
  ctx.db.run("UPDATE candidates SET status='invalidated' WHERE recipient_id=?",account);
  ctx.db.run('UPDATE media_grants SET active=0,revoked_at=COALESCE(revoked_at,?) WHERE recipient_id=? AND active=1',ctx.now(),account);
  ctx.db.run("UPDATE sharing_requests SET status='revoked',updated_at=? WHERE recipient_id=? AND status='accepted'",ctx.now(),account);
}
function revokeAuthentication(account:string,deviceId:string,ctx:AppContext,exceptChallenge?:string):void {
  ctx.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='face_authentication' AND status='granted'",ctx.now(),account);
  ctx.db.run('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),refresh_consumed_at=COALESCE(refresh_consumed_at,?) WHERE account_id=?',ctx.now(),ctx.now(),account);
  ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE account_id=? AND id<>? AND used_at IS NULL",ctx.now(),account,exceptChallenge??'');
  ctx.db.run('UPDATE face_recovery_keys SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=?',ctx.now(),account);
  ctx.db.run('UPDATE face_enrollment_intents SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=?',ctx.now(),account);
  ctx.db.run("UPDATE auth_devices SET status='revoked',face_handle=NULL,revision=? WHERE account_id=? AND id<>?",crypto.randomUUID(),account,deviceId);
}
export function retireProfileReference(profile:Profile,op:LifecycleOperation,ctx:AppContext):string {
  const id=crypto.randomUUID();
  ctx.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",id,profile.account_id,profile.template_key,ctx.now());
  ctx.db.run('INSERT INTO face_profile_retirements(cleanup_id,account_id,operation_key,profile_id,profile_revision,template_key,template_digest) VALUES(?,?,?,?,?,?,?)',
    id,profile.account_id,op.operation_key,profile.id,profile.revision,profile.template_key,profile.template_digest);
  ctx.db.run('UPDATE face_profile_operations SET cleanup_id=? WHERE account_id=? AND operation_key=?',id,profile.account_id,op.operation_key);
  return id;
}
export function finishLifecycleCleanup(ctx:AppContext):void {
  for(const row of ctx.db.all<LifecycleOperation>("SELECT * FROM face_profile_operations WHERE state='pending' AND expires_at<=? LIMIT 100",ctx.now())) {
    if(row.challenge_id && (activeFaceVerifiers(ctx).has(row.challenge_id) || ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1",row.account_id)))continue;
    revokePendingConsent(row.account_id,ctx,row.control_device_id,row.operation_key);
    if(row.challenge_id)ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id=?",ctx.now(),row.challenge_id);
    ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND operation_key=?",row.account_id,row.operation_key);
  }
  for(const row of ctx.db.all<{account_id:string;profile_id:string;profile_revision:string;template_key:string}>(
    "SELECT r.* FROM face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id WHERE c.status='verified' LIMIT 100")) {
    ctx.db.run("DELETE FROM face_profiles WHERE account_id=? AND id=? AND revision=? AND template_key=? AND status='revoked'",row.account_id,row.profile_id,row.profile_revision,row.template_key);
  }
}
async function maintainOwnCleanup(row:Control,ctx:AppContext):Promise<void> {
  if(ctx.db.one("SELECT r.cleanup_id FROM face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id WHERE r.account_id=? AND c.status<>'verified' LIMIT 1",row.account_id)) {
    // Existing bounded maintenance authenticates each exact retired reference;
    // status neither supplies a storage key nor invents deletion completion.
    try {await flushPrivacyCleanup(ctx);}catch{/* Durable cleanup status remains. */}
    controlAuthority(row,ctx);finishLifecycleCleanup(ctx);
  }
}
function revokePendingConsent(account:string,ctx:AppContext,deviceId?:string,operationKey?:string):void {
  ctx.db.run("UPDATE consents SET status='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id IN(SELECT consent_id FROM face_profile_operations WHERE account_id=? AND state='pending' AND (? IS NULL OR control_device_id=?) AND (? IS NULL OR operation_key=?)) AND NOT EXISTS(SELECT 1 FROM face_profiles p WHERE p.auth_consent_id=consents.id)",ctx.now(),account,deviceId??null,deviceId??null,operationKey??null,operationKey??null);
}
export function cancelDeviceLifecycle(account:string,deviceId:string|null,ctx:AppContext):void {
  if(!deviceId)return;
  revokePendingConsent(account,ctx,deviceId);
  ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id IN(SELECT challenge_id FROM face_profile_operations WHERE account_id=? AND control_device_id=? AND state='pending')",ctx.now(),account,deviceId);
  ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND control_device_id=? AND state='pending'",account,deviceId);
}
function cancelPending(account:string,ctx:AppContext):void {
  revokePendingConsent(account,ctx);
  ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id IN(SELECT challenge_id FROM face_profile_operations WHERE account_id=? AND state='pending')",ctx.now(),account);
  ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND state='pending'",account);
}
function version(value:unknown):number {
  if(!Number.isSafeInteger(value)||Number(value)<1)throw new ApiError(400,'face_profile_version_invalid');
  return Number(value);
}
function authConsent(value:unknown,ctx:AppContext,purpose:string):Record<string,any> {
  const consent=record(value);
  if(Object.keys(consent).some(k=>!['purpose','policy_version','granted'].includes(k))||
    consent.purpose!==purpose||consent.granted!==true||consent.policy_version!==(purpose==='face_authentication'?policy(ctx):photoPolicy(ctx)))
    throw new ApiError(400,purpose==='face_authentication'?'explicit_auth_consent_required':'explicit_matching_consent_required');
  return consent;
}
function storeOperation(input:Record<string,any>,hash:string,row:Control,action:string,ctx:AppContext,consentId:string|null=null):LifecycleOperation {
  const s=state(row.account_id,ctx),account=ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',row.account_id)!;
  if(version(input.expected_version)!==s.version)throw new ApiError(409,'face_profile_version_changed');
  const count=ctx.db.one<{n:number}>('SELECT count(*) n FROM face_profile_operations WHERE account_id=? AND created_at>?',row.account_id,ctx.now()-900000)?.n??0;
  if(count>=20)throw new ApiError(429,'face_profile_attempt_limit');
  ctx.db.run("INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,0,?,?)",
    row.account_id,uuid(input.operation_key),action,hash,s.version,row.device_id,row.device_revision,account.auth_epoch,consentId,ctx.now(),ctx.now()+OPERATION_MS);
  return operation(row.account_id,uuid(input.operation_key),ctx)!;
}
function previous(input:Record<string,any>,hash:string,row:Control,ctx:AppContext):LifecycleOperation|null {
  const old=operation(row.account_id,uuid(input.operation_key),ctx);
  if(old&&(old.input_hash!==hash||old.control_device_id!==row.device_id||old.control_revision!==row.device_revision))throw new ApiError(409,'operation_key_conflict');
  return old;
}
async function createControl(request:Request,ctx:AppContext):Promise<Response> {
  const actor=await authenticate(request,ctx);assertRegisteredActor(ctx,actor);
  const input=await jsonBody(request,4096);exact(input,['control_operation_key','renew','previous_control_operation_key'],true);
  const renewing=input.renew===true;
  if((input.renew!=null&&!renewing)||(!renewing&&input.previous_control_operation_key!=null))throw new ApiError(400,'face_profile_input_invalid');
  if(renewing)uuid(input.previous_control_operation_key);
  const account=uuid(input.account_id),deviceId=uuid(input.device_id),key=secret(input.control_key),operationKey=uuid(input.control_operation_key);
  if(actor.accountId!==account)throw new ApiError(403,'face_profile_scope_invalid');
  const currentDevice=ctx.db.one<{device_id:string}>('SELECT device_id FROM sessions WHERE id=?',actor.sessionId)?.device_id;
  const device=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',account,deviceId);
  if(currentDevice!==deviceId||!device||device.status!=='active')throw new ApiError(403,'face_profile_scope_invalid');
  await verifyKey(JSON.parse(device.public_jwk),envelope(input,'control'),input.device_signature);
  const controlHash=await digest(key),keyDigest=await digest(device.public_jwk),creationHash=await inputHash(input);
  ctx.db.transaction(()=>{
    assertRegisteredActor(ctx,actor);noDeletion(account,ctx);
    const still=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',account,deviceId);
    if(!still||stable(still)!==stable(device))throw new ApiError(401,'device_changed');
    const old=ctx.db.one<Control>('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?',account,deviceId);
    if(old) {
      if(old.control_hash===controlHash&&old.control_operation_key===operationKey) {
        if(old.creation_hash!==creationHash)throw new ApiError(409,'operation_key_conflict');
        controlAuthority(old,ctx);
      } else {
        if(!renewing||old.device_revision!==device.revision||old.public_jwk!==device.public_jwk||old.public_key_digest!==keyDigest||controlHash===old.control_hash||operationKey===old.control_operation_key||old.expires_at>ctx.now()||old.control_operation_key!==uuid(input.previous_control_operation_key))throw new ApiError(409,'face_profile_control_exists');
        cancelDeviceLifecycle(account,deviceId,ctx);
        ctx.db.run('UPDATE face_profile_controls SET control_hash=?,control_operation_key=?,creation_hash=?,device_revision=?,public_key_digest=?,public_jwk=?,created_at=?,expires_at=? WHERE account_id=? AND device_id=?',
          controlHash,operationKey,creationHash,device.revision,keyDigest,device.public_jwk,ctx.now(),ctx.now()+CONTROL_MS,account,deviceId);
      }
    } else {
      if(renewing)throw new ApiError(404,'face_profile_control_not_found');
      ctx.db.run('INSERT INTO face_profile_controls(account_id,device_id,control_hash,control_operation_key,creation_hash,device_revision,public_key_digest,public_jwk,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        account,deviceId,controlHash,operationKey,creationHash,device.revision,keyDigest,device.public_jwk,ctx.now(),ctx.now()+CONTROL_MS);
    }
    state(account,ctx);
  });
  return ok(lifecycleMetadata(account,deviceId,ctx),201);
}
async function status(request:Request,ctx:AppContext):Promise<Response> {
  const input=await jsonBody(request,4096);exact(input,['operation_key']);
  const row=await signed(input,'status',ctx);
  const op=input.operation_key==null?null:operation(row.account_id,uuid(input.operation_key),ctx);
  if(input.operation_key!=null&&!op)throw new ApiError(404,'face_profile_operation_not_found');
  if(op&&op.control_device_id!==row.device_id)throw new ApiError(403,'face_profile_scope_invalid');
  await maintainOwnCleanup(row,ctx);nonce(input,ctx);controlAuthority(row,ctx);
  return ok(lifecycleMetadata(row.account_id,row.device_id,ctx,op?operation(row.account_id,op.operation_key,ctx):null,uuid(input.request_nonce)));
}
async function action(request:Request,ctx:AppContext):Promise<Response> {
  const input=await jsonBody(request,4096);exact(input,['operation_key','action','expected_version','consent']);
  const row=await signed(input,'action',ctx),hash=await inputHash(input);
  if(!['pause','resume','withdraw_authentication','remove'].includes(input.action))throw new ApiError(400,'face_profile_action_invalid');
  if(input.action==='resume')authConsent(input.consent,ctx,'photo_matching');
  else if(input.consent!=null)throw new ApiError(400,'face_profile_input_invalid');
  const op=ctx.db.transaction(()=>{
    nonce(input,ctx);controlAuthority(row,ctx);
    const old=previous(input,hash,row,ctx);if(old)return old;
    const profile=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',row.account_id);
    if(!profile||profile.status!=='active')throw new ApiError(409,'face_profile_unavailable');
    const value=storeOperation(input,hash,row,input.action,ctx);
    // Terminal transitions assert precise resulting authority instead of using
    // executeOperation's registered-session postguard after self-revocation.
    cancelPending(row.account_id,ctx);
    if(input.action==='pause'||input.action==='remove') {
      ctx.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching' AND status='granted'",ctx.now(),row.account_id);
      ctx.db.run('UPDATE face_profiles SET consent_id=NULL WHERE account_id=?',row.account_id);
      ctx.db.run('UPDATE account_preferences SET receive_matches=0,updated_at=? WHERE account_id=?',ctx.now(),row.account_id);
      ctx.db.run('UPDATE face_profile_states SET matching_paused=1 WHERE account_id=?',row.account_id);
      invalidateRecipientProfile(row.account_id,ctx);
    }
    if(input.action==='resume') {
      ctx.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching' AND status='granted'",ctx.now(),row.account_id);
      const id=crypto.randomUUID();
      ctx.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision) VALUES(?,?,'photo_matching',?,'granted',?,?)",id,row.account_id,photoPolicy(ctx),ctx.now(),profile.revision);
      ctx.db.run('UPDATE face_profiles SET consent_id=? WHERE account_id=?',id,row.account_id);
      ctx.db.run('UPDATE account_preferences SET receive_matches=1,updated_at=? WHERE account_id=?',ctx.now(),row.account_id);
      ctx.db.run('UPDATE face_profile_states SET matching_paused=0 WHERE account_id=?',row.account_id);
      invalidateRecipientProfile(row.account_id,ctx);
    }
    if(input.action==='withdraw_authentication'||input.action==='remove') {
      revokeAuthentication(row.account_id,row.device_id,ctx);
      ctx.db.run("UPDATE face_profiles SET auth_enabled=0,auth_epoch=auth_epoch+1,status=? WHERE account_id=?",input.action==='remove'?'revoked':'active',row.account_id);
      ctx.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?',row.account_id);
    }
    const retireUnusedAuthentication = ['withdraw_authentication','pause'].includes(input.action) && !hasConsent(ctx,row.account_id,'face_authentication') && !hasConsent(ctx,row.account_id,'photo_matching');
    if(input.action==='remove' || retireUnusedAuthentication) {
      ctx.db.run("UPDATE face_profiles SET status='revoked',auth_enabled=0 WHERE account_id=?",row.account_id);
      ctx.db.run('UPDATE face_profile_states SET matching_paused=1 WHERE account_id=?',row.account_id);
      invalidateRecipientProfile(row.account_id,ctx);
      retireProfileReference(profile,value,ctx);
      ctx.db.run('UPDATE face_profile_states SET removal_operation_key=? WHERE account_id=?',value.operation_key,row.account_id);
    }
    ctx.db.run('UPDATE face_profile_states SET version=version+1 WHERE account_id=?',row.account_id);
    ctx.db.run("UPDATE face_profile_operations SET state='applied' WHERE account_id=? AND operation_key=?",row.account_id,value.operation_key);
    controlAuthority(row,ctx);
    ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
      crypto.randomUUID(),row.account_id,row.account_id,'face_profile.'+input.action,profile.id,'{}',ctx.now());
    return operation(row.account_id,value.operation_key,ctx)!;
  });
  return ok(lifecycleMetadata(row.account_id,row.device_id,ctx,op,uuid(input.request_nonce)));
}
async function cancel(request:Request,ctx:AppContext):Promise<Response> {
  const input=await jsonBody(request,4096);exact(input,['operation_key']);
  const row=await signed(input,'cancel',ctx),key=uuid(input.operation_key);
  const result=ctx.db.transaction(()=>{
    nonce(input,ctx);controlAuthority(row,ctx);
    const op=operation(row.account_id,key,ctx);
    if(!op)throw new ApiError(404,'face_profile_operation_not_found');
    if(op.control_device_id!==row.device_id||op.control_revision!==row.device_revision)throw new ApiError(403,'face_profile_scope_invalid');
    if(op.state==='pending') {
      revokePendingConsent(op.account_id,ctx,row.device_id,key);
      if(op.challenge_id)ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id=?",ctx.now(),op.challenge_id);
      ctx.db.run("UPDATE face_profile_operations SET state='cancelled' WHERE account_id=? AND operation_key=?",row.account_id,key);
    }
    return operation(row.account_id,key,ctx)!;
  });
  return ok(lifecycleMetadata(row.account_id,row.device_id,ctx,result,uuid(input.request_nonce)));
}
function insertChallenge(op:LifecycleOperation,ctx:AppContext):Challenge {
  const profile=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',op.account_id);
  const purpose=op.action==='replace'?'replacement':'registration',required=op.action==='restore_authentication'?1:3;
  const id=crypto.randomUUID(),now=ctx.now();
  ctx.db.run("INSERT INTO auth_challenges(id,account_id,device_id,purpose,nonce,profile_revision,profile_id,policy_version,expires_at,created_at,session_id,auth_epoch,consent_id,device_revision,model_id,profile_auth_epoch,reference_digest,required_captures) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)",
    id,op.account_id,op.control_device_id,purpose,opaque('lfn_'),profile?.revision??null,profile?.id??null,policy(ctx),now+CHALLENGE_MS,now,op.auth_epoch,op.consent_id,op.control_revision,profile?.model_id??null,profile?.auth_epoch??null,profile?.template_digest??null,required);
  ctx.db.run('UPDATE face_profile_operations SET challenge_id=?,generation=generation+1 WHERE account_id=? AND operation_key=?',id,op.account_id,op.operation_key);
  return getChallenge(id,ctx);
}
async function challenge(request:Request,ctx:AppContext):Promise<Response> {
  const input=await jsonBody(request,4096);exact(input,['operation_key','action','expected_version','consent']);
  const row=await signed(input,'challenge',ctx),hash=await inputHash(input);
  if(!['replace','restore_authentication','enroll'].includes(input.action))throw new ApiError(400,'face_profile_action_invalid');
  authConsent(input.consent,ctx,'face_authentication');
  const response=ctx.db.transaction(()=>{
    nonce(input,ctx);controlAuthority(row,ctx);
    const old=previous(input,hash,row,ctx);
    if(old) {
      if(old.state==='completed')throw new ApiError(409,'face_profile_completed');
      lifecycleAuthority(old,ctx);const c=getChallenge(old.challenge_id!,ctx);
      if(c.status!=='pending'||c.expires_at<=ctx.now()||c.used_at!==null)throw new ApiError(409,'face_profile_restart_required');
      return {...challengeResponse(c),lifecycle_operation_key:old.operation_key,lifecycle_generation:old.generation};
    }
    const profile=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',row.account_id),s=state(row.account_id,ctx);
    if(input.action==='enroll') {
      const removal=s.removal_operation_key?operation(row.account_id,s.removal_operation_key,ctx):null;
      if(profile||!removal||cleanupState(removal.cleanup_id,row.account_id,ctx)!=='completed')throw new ApiError(409,'face_profile_cleanup_pending');
    } else if(!profile||profile.status!=='active'||(input.action==='replace'&&profile.auth_enabled!==1)||
      (input.action==='restore_authentication'&&profile.auth_enabled!==0))throw new ApiError(409,'face_profile_unavailable');
    if(ctx.db.one("SELECT operation_key FROM face_profile_operations WHERE account_id=? AND state='pending' LIMIT 1",row.account_id))throw new ApiError(409,'face_profile_operation_pending');
    const consentId=crypto.randomUUID();
    ctx.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision) VALUES(?,?,'face_authentication',?,'granted',?,?)",
      consentId,row.account_id,policy(ctx),ctx.now(),profile?.revision??null);
    const op=storeOperation(input,hash,row,input.action,ctx,consentId),c=insertChallenge(op,ctx);
    return {...challengeResponse(c),lifecycle_operation_key:op.operation_key,lifecycle_generation:1};
  });
  return ok(response,201);
}
async function resume(request:Request,ctx:AppContext):Promise<Response> {
  const input=await jsonBody(request,4096);exact(input,['operation_key','resume_key','expected_challenge_id','expected_generation']);
  const row=await signed(input,'resume',ctx),key=uuid(input.operation_key),resumeKey=uuid(input.resume_key),
    predecessor=uuid(input.expected_challenge_id),generation=version(input.expected_generation);
  const response=ctx.db.transaction(()=>{
    nonce(input,ctx);controlAuthority(row,ctx);const op=operation(row.account_id,key,ctx);
    if(!op||op.control_device_id!==row.device_id)throw new ApiError(404,'face_profile_operation_not_found');
    lifecycleAuthority(op,ctx);
    if(op.last_resume_key===resumeKey) {
      if(op.previous_challenge_id!==predecessor||op.previous_generation!==generation)throw new ApiError(409,'operation_key_conflict');
      const c=getChallenge(op.challenge_id!,ctx);
      return {...challengeResponse(c),lifecycle_operation_key:op.operation_key,lifecycle_generation:op.generation};
    }
    if(op.challenge_id!==predecessor||op.generation!==generation)throw new ApiError(409,'face_profile_operation_changed');
    const old=getChallenge(predecessor,ctx);
    if(old.status==='cancelled'||(old.expires_at>ctx.now()&&!['failed'].includes(old.status)&&old.used_at===null)||
      activeFaceVerifiers(ctx).has(predecessor)||ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1",row.account_id))
      throw new ApiError(409,'face_profile_in_flight');
    ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=COALESCE(used_at,?) WHERE id=?",ctx.now(),old.id);
    const c=insertChallenge(op,ctx);
    ctx.db.run('UPDATE face_profile_operations SET last_resume_key=?,previous_challenge_id=?,previous_generation=? WHERE account_id=? AND operation_key=?',resumeKey,predecessor,generation,row.account_id,key);
    return {...challengeResponse(c),lifecycle_operation_key:op.operation_key,lifecycle_generation:op.generation+1};
  });
  return ok(response,201);
}
/** Called inside the same final challenge transaction; no asynchronous effect. */
export function commitLifecycle(op:LifecycleOperation,challenge:Challenge,newProfile:Profile,ctx:AppContext):void {
  lifecycleAuthority(op,ctx);
  const old=ctx.db.one<Profile>('SELECT * FROM face_profiles WHERE account_id=?',op.account_id);
  const epoch=(challenge.profile_auth_epoch??0)+1;
  revokeAuthentication(op.account_id,op.control_device_id,ctx,challenge.id);
  // The newly explicit authentication consent was cancelled by the broad
  // withdrawal; only this exact challenge's consent is regranted atomically.
  ctx.db.run("UPDATE consents SET status='granted',revoked_at=NULL,profile_revision=? WHERE id=? AND account_id=? AND purpose='face_authentication'",newProfile.revision,op.consent_id,op.account_id);
  if(old) {
    ctx.db.run("UPDATE face_profiles SET revision=?,model_id=?,template_key=?,template_digest=?,status='active',auth_enabled=1,auth_epoch=?,auth_consent_id=? WHERE account_id=?",
      newProfile.revision,newProfile.model_id,newProfile.template_key,newProfile.template_digest,epoch,op.consent_id,op.account_id);
    if(op.action==='replace') {
      if(old.consent_id)ctx.db.run("UPDATE consents SET profile_revision=? WHERE id=? AND account_id=? AND purpose='photo_matching'",newProfile.revision,old.consent_id,op.account_id);
      retireProfileReference(old,op,ctx);invalidateRecipientProfile(op.account_id,ctx);
    }
  } else {
    ctx.db.run("INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,auth_enabled,auth_epoch,auth_consent_id,consent_id) VALUES(?,?,?,?,?,?,'active',1,?,?,NULL)",
      op.account_id,newProfile.id,newProfile.revision,newProfile.model_id,newProfile.template_key,newProfile.template_digest,epoch,op.consent_id);
    ctx.db.run('UPDATE face_profile_states SET removal_operation_key=NULL,matching_paused=1 WHERE account_id=?',op.account_id);
  }
  ctx.db.run("UPDATE accounts SET identity_state='registered_face',auth_epoch=auth_epoch+1 WHERE id=?",op.account_id);
  ctx.db.run('UPDATE face_profile_states SET version=version+1 WHERE account_id=?',op.account_id);
  ctx.db.run("UPDATE face_profile_operations SET state='completed' WHERE account_id=? AND operation_key=?",op.account_id,op.operation_key);
  ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
    crypto.randomUUID(),op.account_id,op.account_id,'face_profile.'+op.action,newProfile.id,'{}',ctx.now());
}
export function nextLifecycleAt(ctx:AppContext):number|null {
  const pending=ctx.db.one("SELECT cleanup_id FROM face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id WHERE c.status<>'verified' LIMIT 1");
  const due=ctx.db.one<{due:number|null}>("SELECT min(expires_at) due FROM face_profile_operations WHERE state='pending'")?.due ?? null;
  return pending?Math.min(ctx.now()+60000,due??Infinity):due;
}
export async function handleFaceProfile(request:Request,ctx:AppContext):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/me/face-profile') {
    const actor=await authenticate(request,ctx);assertRegisteredActor(ctx,actor);
    const session=ctx.db.one<{device_id:string}>('SELECT device_id FROM sessions WHERE id=?',actor.sessionId)!;
    const device=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',actor.accountId,session.device_id);
    if(!device || device.status!=='active')throw new ApiError(401,'device_scope_invalid');
    const publicKeyDigest=await digest(device.public_jwk);
    assertRegisteredActor(ctx,actor);
    const current=ctx.db.one<Device>('SELECT * FROM auth_devices WHERE account_id=? AND id=?',actor.accountId,session.device_id);
    if(!current || stable(current)!==stable(device))throw new ApiError(401,'device_scope_invalid');
    return ok({...lifecycleMetadata(actor.accountId,device.id,ctx),public_key_digest:publicKeyDigest});
  }
  if(request.method!=='POST')return null;
  if(path==='/auth/face/profile/control')return createControl(request,ctx);
  if(path==='/auth/face/profile/status')return status(request,ctx);
  if(path==='/auth/face/profile/action')return action(request,ctx);
  if(path==='/auth/face/profile/challenge')return challenge(request,ctx);
  if(path==='/auth/face/profile/resume')return resume(request,ctx);
  if(path==='/auth/face/profile/cancel')return cancel(request,ctx);
  return null;
}
