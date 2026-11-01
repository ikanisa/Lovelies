/** Operator-only crypto and guarded rotation. No provider calls or Auth writes. */
import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';

export const ROTATION_PROTOCOL='lovelies-managed-auth-key-rotation-v1';
export const ROTATION_ABORT_PROTOCOL='lovelies-managed-auth-key-rotation-abort-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
export const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
export const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(left,right)=>canonical(left)===canonical(right);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function decodeKey(value){
 if(typeof value!=='string'||!value||value.length>48||!/^[A-Za-z0-9_+/=-]+$/.test(value))return fail('rotation_key_invalid');
 let bytes;try{bytes=Buffer.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),'binary');}catch{return fail('rotation_key_invalid');}
 if(bytes.length!==32){bytes.fill(0);return fail('rotation_key_invalid');}return bytes;
}
export function rotationKeys(oldValue,newValue,signingValues=[]){
 const oldKey=decodeKey(oldValue);let newKey;
 try{
  newKey=decodeKey(newValue);
  if(timingSafeEqual(oldKey,newKey))return fail('rotation_key_not_distinct');
  for(const value of signingValues){
   const raw=Buffer.from(String(value??''),'utf8');
   let decoded;try{
    try{decoded=decodeKey(value);}catch{}
    if(value===oldValue||value===newValue||raw.length===32&&(timingSafeEqual(raw,oldKey)||timingSafeEqual(raw,newKey))||decoded&&(timingSafeEqual(decoded,oldKey)||timingSafeEqual(decoded,newKey)))return fail('rotation_key_not_distinct');
   }finally{raw.fill(0);decoded?.fill(0);}
  }
  return {oldKey,newKey};
 }catch(error){oldKey.fill(0);newKey?.fill(0);throw error;}
}
export const keyFingerprint=value=>{const key=decodeKey(value);try{return digest(key);}finally{key.fill(0);}};
const escrowKey=(key,id,purpose)=>Buffer.from(hkdfSync('sha256',key,Buffer.from(id),'lovelies-managed-auth-rotation:'+purpose,32));
export function sealEscrow(value,master){
 if(!UUID.test(value.rotation_id)||master.length!==32)return fail('rotation_escrow_invalid');
 const header={protocol:ROTATION_PROTOCOL,rotation_id:value.rotation_id},iv=randomBytes(12),key=escrowKey(master,value.rotation_id,'escrow'),bytes=Buffer.from(canonical(value));
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return {header,iv:iv.toString('base64url'),ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
 }finally{bytes.fill(0);key.fill(0);}
}
export function openEscrow(envelope,master){
 if(!exact(envelope,['header','iv','ciphertext','tag'])||!exact(envelope.header,['protocol','rotation_id'])||envelope.header.protocol!==ROTATION_PROTOCOL||!UUID.test(envelope.header.rotation_id)||master.length!==32)return fail('rotation_escrow_invalid');
 const key=escrowKey(master,envelope.header.rotation_id,'escrow');let bytes;
 try{const iv=Buffer.from(envelope.iv,'base64url'),tag=Buffer.from(envelope.tag,'base64url');
  if(iv.length!==12||tag.length!==16||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>256*1024)return fail('rotation_escrow_invalid');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(canonical(envelope.header)));decipher.setAuthTag(tag);
  bytes=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64url')),decipher.final()]);const value=JSON.parse(bytes.toString('utf8'));
  if(value.rotation_id!==envelope.header.rotation_id)return fail('rotation_escrow_invalid');return value;
 }catch{return fail('rotation_escrow_invalid');}finally{bytes?.fill(0);key.fill(0);}
}
export function sealIntent(intent,master){validateIntent(intent);const key=escrowKey(master,intent.rotation_id,'intent');try{return {intent,hmac_sha256:createHmac('sha256',key).update(canonical(intent)).digest('hex')};}finally{key.fill(0);}}
export function openIntent(envelope,master){
 if(!exact(envelope,['intent','hmac_sha256'])||!HASH.test(envelope.hmac_sha256??''))return fail('rotation_intent_invalid');
 const expected=sealIntent(envelope.intent,master).hmac_sha256;
 if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(envelope.hmac_sha256,'hex')))return fail('rotation_intent_invalid');return envelope.intent;
}
export function validateIntent(value){
 if(!exact(value,['protocol','rotation_id','created_at','expected_marker','pre_state','escrow_sha256','api_before_sha256','api_after_sha256'])||value.protocol!==ROTATION_PROTOCOL||!UUID.test(value.rotation_id)||!Number.isSafeInteger(value.created_at)||value.created_at<1||!value.expected_marker||!UUID.test(value.expected_marker.database_id??'')||!UUID.test(value.expected_marker.incarnation_id??'')||['escrow_sha256','api_before_sha256','api_after_sha256'].some(key=>!HASH.test(value[key]??'')))return fail('rotation_intent_invalid');
 const marker=value.expected_marker;
 if(!exact(marker,['database_id','incarnation_id','checkpoint','cursor'])||!exact(marker.checkpoint,['revision','hash'])||!exact(marker.cursor,['sequence','hash'])||
  !Number.isSafeInteger(marker.checkpoint.revision)||marker.checkpoint.revision<0||!Number.isSafeInteger(marker.cursor.sequence)||marker.cursor.sequence<0||
  !HASH.test(marker.checkpoint.hash??'')||!HASH.test(marker.cursor.hash??'')||marker.cursor.sequence===0&&marker.cursor.hash!=='0'.repeat(64))return fail('rotation_intent_invalid');
 validateState(value.pre_state);return value;
}
function validateState(value){if(!exact(value,['row_count','encrypted_rows','rows_sha256'])||!Number.isSafeInteger(value.row_count)||value.row_count<0||value.row_count>1_000_000||!Number.isSafeInteger(value.encrypted_rows)||value.encrypted_rows<0||value.encrypted_rows>value.row_count||!HASH.test(value.rows_sha256??''))return fail('rotation_state_invalid');}
export const mutationIntent=value=>({operation_id:validateIntent(value).rotation_id,input_hash:digest(canonical({protocol:'lovelies-managed-auth-key-mutation-v1',intent:value})),allocations:{},events:[]});
function aad(row){return Buffer.from(canonical({protocol:'lovelies-managed-auth-custody-v1',id:row.id,account_id:row.account_id,incarnation_id:row.incarnation_id,auth_user_id:row.auth_user_id,auth_session_id:row.auth_session_id}));}
function credentialBytes(value,maximum){
 if(typeof value!=='string'||!value||value.length>Math.ceil(maximum*4/3)+4||!/^[A-Za-z0-9_+/=-]+$/.test(value))return fail('rotation_credential_invalid');
 try{const bytes=Buffer.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),'binary');if(bytes.length>maximum){bytes.fill(0);return fail('rotation_credential_invalid');}return bytes;}catch{return fail('rotation_credential_invalid');}
}
export function decryptCredential(row,key){
 if(!UUID.test(row.id??'')||!UUID.test(row.account_id??'')||!UUID.test(row.incarnation_id??'')||!UUID.test(row.auth_user_id??'')||!UUID.test(row.auth_session_id??'')||!Number.isSafeInteger(row.tokens_expires_at))return fail('rotation_credential_invalid');
 const iv=credentialBytes(row.iv,12),cipher=credentialBytes(row.ciphertext,24576);let bytes;
 try{
  if(iv.length!==12||cipher.length<17)return fail('rotation_credential_invalid');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad(row));decipher.setAuthTag(cipher.subarray(-16));
  bytes=Buffer.concat([decipher.update(cipher.subarray(0,-16)),decipher.final()]);const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(value,['access_token','refresh_token','user_id','session_id','expires_at'])||value.user_id!==row.auth_user_id||value.session_id!==row.auth_session_id||value.expires_at!==row.tokens_expires_at||typeof value.access_token!=='string'||typeof value.refresh_token!=='string')return fail('rotation_credential_invalid');
  return value;
 }catch{return fail('rotation_credential_invalid');}finally{bytes?.fill(0);iv.fill(0);cipher.fill(0);}
}
export function encryptCredential(value,row,key){
 const iv=randomBytes(12),bytes=Buffer.from(JSON.stringify(value));
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(row));
  return {iv:iv.toString('base64url'),ciphertext:Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]).toString('base64url')};
 }finally{bytes.fill(0);iv.fill(0);}
}
const hasCredential=row=>{if((row.ciphertext===null)!==(row.iv===null))return fail('rotation_credential_invalid');return row.ciphertext!==null;};
function validateNumericRow(row){
 // jsonb decoding bypasses the driver's scalar BIGINT parser. Never hash a
 // rounded timestamp, even for a row that currently has no encrypted tokens.
 for(const name of ['created_at','updated_at','retire_after','tokens_expires_at','logout_verified_at','user_deleted_at','reconcile_page']){
  if(row[name]!==null&&!Number.isSafeInteger(row[name]))return fail('rotation_inventory_integer_invalid');
 }
}
async function eachRow(c,callback){let after='',count=0;for(;;){const rows=await c.query('SELECT to_jsonb(m) AS value FROM lovelies_private.managed_auth_bindings m WHERE id COLLATE "C">$1 ORDER BY id COLLATE "C" LIMIT 128',[after]);for(const {value:row} of rows){if(++count>1_000_000||typeof row.id!=='string'||row.id<=after)return fail('rotation_inventory_invalid');validateNumericRow(row);await callback(row);after=row.id;}if(rows.length<128)return count;}}
function inventoryHash(){const hash=createHash('sha256');hash.update('[');let count=0;return {add(row){if(count++)hash.update(',');hash.update(canonical(row));},finish(){hash.update(']');return hash.digest('hex');}};}
export async function inspectRows(c,key){const hash=inventoryHash();let encrypted=0;const count=await eachRow(c,async row=>{if(hasCredential(row)){decryptCredential(row,key);encrypted++;}hash.add(row);});return {row_count:count,encrypted_rows:encrypted,rows_sha256:hash.finish()};}
export async function classifyRows(c,oldKey,newKey){let old=0,next=0,empty=0;await eachRow(c,async row=>{if(!hasCredential(row)){empty++;return;}let before=false,after=false;try{decryptCredential(row,oldKey);before=true;}catch{}try{decryptCredential(row,newKey);after=true;}catch{}if(before===after)return fail('rotation_credential_invalid');if(before)old++;else next++;});return {state:old&&next?'mixed':old?'old':next?'new':'empty',old_rows:old,new_rows:next,empty_rows:empty};}
async function rewriteRows(c,oldKey,newKey,expected){
 const before=inventoryHash(),after=inventoryHash();let encrypted=0;
 const count=await eachRow(c,async row=>{before.add(row);let next=row;if(hasCredential(row)){
  const values=encryptCredential(decryptCredential(row,oldKey),row,newKey);next={...row,...values};
  const updated=await c.query('UPDATE lovelies_private.managed_auth_bindings SET ciphertext=$1,iv=$2 WHERE id=$3 AND ciphertext=$4 AND iv=$5 RETURNING id',[values.ciphertext,values.iv,row.id,row.ciphertext,row.iv]);
  if(updated.length!==1||updated[0].id!==row.id)return fail('rotation_row_changed');encrypted++;
 }after.add(next);});
 const prior={row_count:count,encrypted_rows:encrypted,rows_sha256:before.finish()};if(!same(prior,expected))return fail('rotation_pre_state_changed');
 const next={row_count:count,encrypted_rows:encrypted,rows_sha256:after.finish()};if(!same(await inspectRows(c,newKey),next))return fail('rotation_post_state_changed');return next;
}
async function appRole(c){await c.query('SET LOCAL ROLE lovelies_api',[]);await c.query('SET LOCAL search_path TO lovelies_private,pg_catalog',[]);}
async function locked(c,write=false){await c.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)',[]);await appRole(c);if(write)await c.query('LOCK TABLE lovelies_private.managed_auth_bindings IN SHARE ROW EXCLUSIVE MODE',[]);}
async function receipt(c,id){await c.query('RESET ROLE',[]);try{const rows=await c.query('SELECT receipt_json FROM lovelies_deployment.managed_auth_key_rotations WHERE rotation_id=$1',[id]);if(rows.length>1)return fail('rotation_receipt_invalid');return rows.length?JSON.parse(rows[0].receipt_json):null;}finally{await appRole(c);}}
async function marker(c){const rows=await c.query('SELECT * FROM lovelies_private.restore_control WHERE singleton=1',[]);if(rows.length!==1)return fail('rotation_restore_identity_invalid');const row=rows[0];return {row,marker:{database_id:row.database_id,incarnation_id:row.incarnation_id,checkpoint:{revision:Number(row.checkpoint_revision),hash:row.checkpoint_hash},cursor:{sequence:Number(row.journal_sequence),hash:row.journal_hash}}};}
function verifyReceipt(value,intent,operation){
 if(!exact(value,['protocol','rotation_id','input_hash','escrow_sha256','expected_marker','next_marker','plan_hash','pre_state','post_state'])||value.protocol!==ROTATION_PROTOCOL||value.rotation_id!==intent.rotation_id||value.input_hash!==mutationIntent(intent).input_hash||value.escrow_sha256!==intent.escrow_sha256||!same(value.expected_marker,intent.expected_marker)||!same(value.pre_state,intent.pre_state)||!operation||!['pending','committed'].includes(operation.status)||operation.plan_hash!==value.plan_hash||operation.plan.input_hash!==value.input_hash||operation.plan.operation_id!==value.rotation_id||!same(operation.plan.expected,value.expected_marker)||!same(operation.plan.next,value.next_marker))return fail('rotation_receipt_unconfirmed');
 validateState(value.post_state);if(value.post_state.row_count!==value.pre_state.row_count||value.post_state.encrypted_rows!==value.pre_state.encrypted_rows)return fail('rotation_receipt_unconfirmed');return value;
}
async function verifyInside(c,ports,intent,newKey){
 const value=await receipt(c,intent.rotation_id),operation=await ports.journal.lookup(intent.rotation_id);verifyReceipt(value,intent,operation);
 const local=await marker(c);if(!same(local.marker,value.next_marker)||local.row.last_operation_id!==intent.rotation_id||local.row.last_plan_hash!==value.plan_hash)return fail('rotation_post_marker_changed');
 if(!same(await inspectRows(c,newKey),value.post_state))return fail('rotation_post_state_changed');return value;
}
export async function inspectDatabase(ports,expected,key){return ports.connection.begin(async c=>{await locked(c);const control=await ports.journal.control();if(control.state!=='serving'||control.pending_operation_id!==null||!same(control.marker,expected))return fail('rotation_restore_not_serving');await ports.fence.enter(c);const local=await marker(c);if(!same(local.marker,expected))return fail('rotation_restore_identity_invalid');return inspectRows(c,key);});}
export async function verifyDatabase(ports,intent,newKey){
 validateIntent(intent);return ports.connection.begin(async c=>{await locked(c,true);const value=await verifyInside(c,ports,intent,newKey);
  // An acknowledged SQL receipt plus complete new-key state is checked before
  // enter may reconcile a lost independent commit acknowledgement.
  await ports.fence.enter(c);const operation=await ports.journal.lookup(intent.rotation_id),control=await ports.journal.control();
  if(operation?.status!=='committed'||control.state!=='serving'||control.pending_operation_id!==null||!same(control.marker,value.next_marker))return fail('rotation_journal_acknowledgement_unconfirmed');return value;
 });
}
export async function rotateDatabase(ports,intent,oldKey,newKey,{afterRewrite,afterPrepare,afterCommit}={}){
 validateIntent(intent);if(oldKey.length!==32||newKey.length!==32||timingSafeEqual(oldKey,newKey))return fail('rotation_key_not_distinct');
 let prepared;
 const value=await ports.connection.begin(async c=>{
  await locked(c,true);if(await receipt(c,intent.rotation_id))return fail('rotation_already_committed_verify_required');
  // Never rerun an ID accepted by independent custody, even if SQL has no row.
  // The ordinary restore protocol must retire that outcome first.
  const priorOperation=await ports.journal.lookup(intent.rotation_id);
  if(priorOperation?.status==='recovered')throw Object.assign(Error('rotation_operation_retired_by_recovery'),{status:410});
  if(priorOperation)return fail('rotation_accepted_outcome_requires_reconciliation');
  const control=await ports.journal.control();if(control.state!=='serving'||control.pending_operation_id!==null||!same(control.marker,intent.expected_marker))return fail('rotation_restore_not_serving');
  const admission=await ports.fence.enter(c),local=await marker(c);if(!same(local.marker,intent.expected_marker))return fail('rotation_restore_identity_invalid');
  const mutation=mutationIntent(intent);await ports.fence.checkIntent(c,admission,mutation);
  // Normal writer protocol, after independent admission. This is not restore replay.
  await c.query("SELECT set_config('lovelies.writer_protocol','2',true)",[]);
  const post=await rewriteRows(c,oldKey,newKey,intent.pre_state);await afterRewrite?.();
  prepared=await ports.fence.prepare(c,admission,mutation);await afterPrepare?.();
  const result={protocol:ROTATION_PROTOCOL,rotation_id:intent.rotation_id,input_hash:mutation.input_hash,escrow_sha256:intent.escrow_sha256,
   expected_marker:intent.expected_marker,next_marker:prepared.plan.next,plan_hash:prepared.plan_hash,pre_state:intent.pre_state,post_state:post};
  await c.query('RESET ROLE',[]);
  await c.query('INSERT INTO lovelies_deployment.managed_auth_key_rotations(rotation_id,input_hash,receipt_json) VALUES($1,$2,$3)',[intent.rotation_id,mutation.input_hash,canonical(result)]);
  await appRole(c);return result;
 });
 await afterCommit?.();
 await ports.connection.begin(async c=>{await locked(c,true);await verifyInside(c,ports,intent,newKey);await ports.fence.committed(c,prepared);});
 return verifyDatabase(ports,intent,newKey);
}
export async function applyOrVerifyDatabase(ports,intent,oldKey,newKey){
 const exists=await ports.connection.begin(async c=>{await locked(c,true);return receipt(c,intent.rotation_id);});
 if(exists?.protocol===ROTATION_ABORT_PROTOCOL)throw Object.assign(Error('rotation_operation_retired_by_recovery'),{status:410});
 return exists?verifyDatabase(ports,intent,newKey):rotateDatabase(ports,intent,oldKey,newKey);
}
function emptyRotationPlan(operation,intent,statuses){
 const plan=operation?.plan;
 if(!plan||!statuses.includes(operation.status)||plan.version!==1||plan.operation_id!==intent.rotation_id||plan.input_hash!==mutationIntent(intent).input_hash||
  !same(plan.expected,intent.expected_marker)||!same(plan.next.cursor,plan.expected.cursor)||
  !plan.allocations||Object.keys(plan.allocations).length!==0||!Array.isArray(plan.events)||plan.events.length!==0||!Array.isArray(plan.receipts)||plan.receipts.length!==0)return fail('rotation_abort_plan_invalid');
 return operation;
}
async function verifyAbortInside(c,ports,intent,oldKey){
 const value=await receipt(c,intent.rotation_id),operation=emptyRotationPlan(await ports.journal.lookup(intent.rotation_id),intent,['pending','recovered']);
 if(!exact(value,['protocol','rotation_id','input_hash','escrow_sha256','expected_marker','next_marker','plan_hash','pre_state','post_state'])||
  value.protocol!==ROTATION_ABORT_PROTOCOL||value.rotation_id!==intent.rotation_id||value.input_hash!==mutationIntent(intent).input_hash||value.escrow_sha256!==intent.escrow_sha256||
  value.plan_hash!==operation.plan_hash||!same(value.expected_marker,intent.expected_marker)||!same(value.next_marker,operation.plan.next)||
  !same(value.pre_state,intent.pre_state)||!same(value.post_state,intent.pre_state))return fail('rotation_abort_receipt_unconfirmed');
 const local=await marker(c),negative=await c.query('SELECT input_hash,plan_hash,outcome FROM lovelies_private.restore_recovered_operations WHERE operation_id=$1',[intent.rotation_id]);
 if(!same(local.marker,value.next_marker)||local.row.last_operation_id!==intent.rotation_id||local.row.last_plan_hash!==value.plan_hash||negative.length!==1||
  negative[0].input_hash!==value.input_hash||negative[0].plan_hash!==value.plan_hash||negative[0].outcome!=='restricted-abort')return fail('rotation_abort_marker_unconfirmed');
 if(!same(await inspectRows(c,oldKey),intent.pre_state))return fail('rotation_abort_old_state_changed');return value;
}
export async function verifyAbortedDatabase(ports,intent,oldKey){
 validateIntent(intent);return ports.connection.begin(async c=>{await locked(c,true);const value=await verifyAbortInside(c,ports,intent,oldKey);
  // Only the exact atomic negative receipt, recovered-operation row and unchanged
  // old-key state authorize reconciliation of a lost negative COMMIT reply.
  await ports.fence.enter(c);const operation=await ports.journal.lookup(intent.rotation_id),control=await ports.journal.control();
  if(operation?.status!=='recovered'||control.state!=='serving'||control.pending_operation_id!==null||control.recovery_generation_id!==null||!same(control.marker,value.next_marker))return fail('rotation_abort_acknowledgement_unconfirmed');return value;
 });
}
export async function abortDatabase(ports,intent,oldKey,{afterReconcile,afterCommit}={}){
 validateIntent(intent);
 await ports.connection.begin(async c=>{
  await locked(c,true);if(await receipt(c,intent.rotation_id))return fail('rotation_abort_existing_receipt_requires_verification');
  const operation=emptyRotationPlan(await ports.journal.lookup(intent.rotation_id),intent,['pending']),control=await ports.journal.control(),local=await marker(c);
  if(control.state!=='pending'||control.pending_operation_id!==intent.rotation_id||control.recovery_generation_id!==null||!same(control.marker,intent.expected_marker)||!same(local.marker,intent.expected_marker))return fail('rotation_abort_restore_state_invalid');
  if(!same(await inspectRows(c,oldKey),intent.pre_state))return fail('rotation_abort_old_state_changed');
  // The established restricted-abort implementation owns replay mode, the
  // recovered-operation row and marker transition. Never synthesize those here.
  await ports.fence.reconcile(c);await afterReconcile?.();
  const next=await marker(c);if(!same(next.marker,operation.plan.next)||next.row.last_operation_id!==intent.rotation_id||next.row.last_plan_hash!==operation.plan_hash)return fail('rotation_abort_marker_unconfirmed');
  const value={protocol:ROTATION_ABORT_PROTOCOL,rotation_id:intent.rotation_id,input_hash:mutationIntent(intent).input_hash,escrow_sha256:intent.escrow_sha256,
   expected_marker:intent.expected_marker,next_marker:operation.plan.next,plan_hash:operation.plan_hash,pre_state:intent.pre_state,post_state:intent.pre_state};
  await c.query('RESET ROLE',[]);
  await c.query('INSERT INTO lovelies_deployment.managed_auth_key_rotations(rotation_id,input_hash,receipt_json) VALUES($1,$2,$3)',[intent.rotation_id,value.input_hash,canonical(value)]);
  await appRole(c);
 });
 await afterCommit?.();return verifyAbortedDatabase(ports,intent,oldKey);
}
export async function abortOrVerifyDatabase(ports,intent,oldKey){
 const value=await ports.connection.begin(async c=>{await locked(c,true);return receipt(c,intent.rotation_id);});
 if(value&&value.protocol!==ROTATION_ABORT_PROTOCOL)return fail('rotation_positive_receipt_cannot_abort');
 return value?verifyAbortedDatabase(ports,intent,oldKey):abortDatabase(ports,intent,oldKey);
}
export async function verifyRotationOutcome(ports,intent,oldKey,newKey){
 const value=await ports.connection.begin(async c=>{await locked(c,true);return receipt(c,intent.rotation_id);});
 return value?.protocol===ROTATION_ABORT_PROTOCOL?verifyAbortedDatabase(ports,intent,oldKey):verifyDatabase(ports,intent,newKey);
}
