import {randomUUID} from 'node:crypto';
import {PROJECT_ID,canonical,sha256} from '../src/journal.mjs';
async function id(namespace,value){const h=(await sha256(canonical({namespace,project_id:PROJECT_ID,value}))).slice(0,32).split('');h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export async function downloadReservationInput(marker){
  const context={protocol:'lovelies-download-input-v2',account_id:randomUUID(),operation_key:randomUUID(),original_session_id:randomUUID(),asset_id:randomUUID(),source_version:'source-v1',capability_sha256:'a'.repeat(64)};
  const operation_id=await id('lovelies-database-logical-operation-v1',{actor_id:context.account_id,source:'media.download.sign.v2',operation_key:context.operation_key});
  const ticket_id=await id('lovelies-database-allocation-slot-v1',{operation_id,slot:'id_0'}),input_hash=await sha256(canonical(context)),expected=marker;
  const {account_id,operation_key,original_session_id,asset_id,source_version}=context;
  const e={protocol:'lovelies-download-evidence-v2',disposition:'not_issued',operation_id,input_hash,recorded_at:1000,context,ticket_id,expected,ticket:null,
    wire:{protocol:'lovelies-download-operation-v2',status:'not_issued',account_id,operation_key,original_session_id,asset_id,source_version}};
  // The journal holds opaque MACs; only the actual backend MAC verifier may
  // certify their SQL preimage. This unit test does not fake a signing key.
  const seal={key_id:'synthetic-opaque-mac',evidence_json:canonical(e),mac_sha256:'b'.repeat(64)};seal.receipt_hash=await sha256(canonical(seal));
  const input={version:1,project_id:PROJECT_ID,operation_id,input_hash,expected,allocations:{id_0:ticket_id},events:[],
    download:{kind:'download-issuance-v2',context,ticket_id,issued_receipt_hash:'c'.repeat(64),not_issued:seal}};
  return input;
}
