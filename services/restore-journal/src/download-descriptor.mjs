/** Only a reservation for issuance, never restrictions, bytes or external saves.
 * The independent store binds both possible SQL dispositions before either can
 * be acknowledged. It has no MAC signing key and cannot create a capability. */
import { PROJECT_ID, canonical, sha256, exact, fail, uuidPattern, hashPattern } from './journal.mjs';
const same = (a,b) => canonical(a) === canonical(b);
const uuid = v => typeof v === 'string' && uuidPattern.test(v);
const hash = v => typeof v === 'string' && hashPattern.test(v);
const invalid = () => fail(400,'download_reservation_invalid');
async function identifier(namespace,value) {
  const h=(await sha256(canonical({namespace,project_id:PROJECT_ID,value}))).slice(0,32).split('');
  h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const s=h.join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export async function validateDownloadReservation(raw,input) {
  if (!exact(raw,['kind','context','ticket_id','issued_receipt_hash','not_issued']) || raw.kind!=='download-issuance-v2' ||
      !uuid(raw.ticket_id) || !hash(raw.issued_receipt_hash)) return invalid();
  const c=raw.context,s=raw.not_issued;
  if (!exact(c,['protocol','account_id','operation_key','original_session_id','asset_id','source_version','capability_sha256']) ||
      c.protocol!=='lovelies-download-input-v2' || !uuid(c.account_id) || !uuid(c.original_session_id) || !uuid(c.asset_id) ||
      typeof c.operation_key!=='string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(c.operation_key) ||
      typeof c.source_version!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(c.source_version) || !hash(c.capability_sha256) ||
      !exact(s,['key_id','evidence_json','mac_sha256','receipt_hash']) || typeof s.key_id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.key_id) ||
      typeof s.evidence_json!=='string' || new TextEncoder().encode(s.evidence_json).length>24000 || !hash(s.mac_sha256) || !hash(s.receipt_hash)) return invalid();
  let e;try{e=JSON.parse(s.evidence_json);}catch{return invalid();}
  const {account_id,operation_key,original_session_id,asset_id,source_version}=c;
  const wire={protocol:'lovelies-download-operation-v2',status:'not_issued',account_id,operation_key,original_session_id,asset_id,source_version};
  if (!exact(e,['protocol','disposition','operation_id','input_hash','recorded_at','context','ticket_id','expected','ticket','wire']) ||
      !Number.isSafeInteger(e.recorded_at) || e.recorded_at<0 || e.protocol!=='lovelies-download-evidence-v2' || e.disposition!=='not_issued' || e.ticket!==null ||
      !same(e.context,c) || !same(e.wire,wire) || canonical(e)!==s.evidence_json || !same(e.expected,input.expected) ||
      e.operation_id!==input.operation_id || e.input_hash!==input.input_hash || e.ticket_id!==raw.ticket_id ||
      !same(input.allocations,{id_0:raw.ticket_id}) || input.events.length!==0 ||
      input.input_hash!==await sha256(canonical(c)) || input.operation_id!==await identifier('lovelies-database-logical-operation-v1',
        {actor_id:account_id,source:'media.download.sign.v2',operation_key}) ||
      raw.ticket_id!==await identifier('lovelies-database-allocation-slot-v1',{operation_id:input.operation_id,slot:'id_0'}) ||
      s.receipt_hash!==await sha256(canonical({key_id:s.key_id,evidence_json:s.evidence_json,mac_sha256:s.mac_sha256}))) return invalid();
  return JSON.parse(canonical(raw));
}
export function downloadDispositionHash(plan,disposition) {
  if (!plan.download || !['issued','not_issued'].includes(disposition)) return invalid();
  return disposition==='issued'?plan.download.issued_receipt_hash:plan.download.not_issued.receipt_hash;
}
