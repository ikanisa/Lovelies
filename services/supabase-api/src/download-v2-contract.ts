import { ApiError, digest, stable } from './types.ts';
import type { RestoreMarker } from './restore-journal.ts';
import { restoreAllocationID, restoreOperationID } from './restore-transaction.ts';

export const DOWNLOAD_INPUT = 'lovelies-download-input-v2' as const;
export const DOWNLOAD_RESULT = 'lovelies-download-operation-v2' as const;
export const DOWNLOAD_SOURCE = 'media.download.sign.v2';
export const DOWNLOAD_CAPABILITY_HEADER = 'X-Lovelies-Download-Capability';
export const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const downloadUnresolved = (): never => { throw new ApiError(503, 'download_operation_outcome_unresolved'); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
export const downloadExact = (v: unknown, fields: readonly string[]): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
export type DownloadContext = Readonly<{ protocol: typeof DOWNLOAD_INPUT; account_id: string; operation_key: string;
  original_session_id: string; asset_id: string; source_version: string; capability_sha256: string }>;
export type DownloadWire = Readonly<{ protocol: typeof DOWNLOAD_RESULT; status: 'recorded' | 'not_issued'; account_id: string;
  operation_key: string; original_session_id: string; asset_id: string; source_version: string; created_at?: number; expires_at?: number }>;
export type DownloadTicket = Readonly<{ id: string; created_at: number; expires_at: number; source_checksum: string;
  object_key: string; content_type: string; byte_size: number; subscription_id: string; subscription_version: number;
  authority: unknown; admission: unknown; session: unknown }>;
export type DownloadEvidence = Readonly<{ protocol: 'lovelies-download-evidence-v2'; disposition: 'issued' | 'not_issued';
  operation_id: string; input_hash: string; recorded_at: number; context: DownloadContext; ticket_id: string; expected: RestoreMarker;
  ticket: DownloadTicket | null; wire: DownloadWire }>;
export type DownloadSeal = Readonly<{ key_id: string; evidence_json: string; mac_sha256: string; receipt_hash: string }>;
export type DownloadDescriptor = Readonly<{ kind: 'download-issuance-v2'; context: DownloadContext; ticket_id: string;
  issued_receipt_hash: string; not_issued: DownloadSeal }>;
export type DownloadKeyConfiguration = { DOWNLOAD_RECEIPT_KEY_ID?: string; DOWNLOAD_RECEIPT_KEYS_JSON?: string; MEDIA_SIGNING_SECRET?: string };

export function validateDownloadContext(v: unknown): DownloadContext {
  if (!downloadExact(v, ['protocol','account_id','operation_key','original_session_id','asset_id','source_version','capability_sha256']) ||
      v.protocol !== DOWNLOAD_INPUT || !UUID.test(v.account_id) || !UUID.test(v.original_session_id) || !UUID.test(v.asset_id) ||
      typeof v.operation_key !== 'string' || !KEY.test(v.operation_key) || typeof v.source_version !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.source_version) || typeof v.capability_sha256 !== 'string' || !HASH.test(v.capability_sha256)) return downloadUnresolved();
  return Object.freeze({ ...v }) as DownloadContext;
}
export async function parseDownloadInput(body: unknown, capability: string | null, account: string): Promise<DownloadContext> {
  if (!downloadExact(body, ['protocol','operation_key','original_session_id','asset_id','source_version']) ||
      typeof capability !== 'string' || !/^lvd_v2_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(capability))
    throw new ApiError(400, 'invalid_download_input');
  try { return validateDownloadContext({ ...body, account_id: account, capability_sha256: await digest(capability) }); }
  catch { throw new ApiError(400, 'invalid_download_input'); }
}
export function downloadWire(context: DownloadContext, ticket: DownloadTicket | null): DownloadWire {
  const { account_id, operation_key, original_session_id, asset_id, source_version } = context;
  return Object.freeze({ protocol: DOWNLOAD_RESULT, status: ticket ? 'recorded' : 'not_issued', account_id, operation_key,
    original_session_id, asset_id, source_version, ...(ticket ? { created_at: ticket.created_at, expires_at: ticket.expires_at } : {}) });
}
export function validateDownloadSeal(v: unknown): DownloadSeal {
  if (!downloadExact(v, ['key_id','evidence_json','mac_sha256','receipt_hash']) || typeof v.key_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(v.key_id) || typeof v.evidence_json !== 'string' || new TextEncoder().encode(v.evidence_json).length > 24000 ||
      typeof v.mac_sha256 !== 'string' || !HASH.test(v.mac_sha256) || typeof v.receipt_hash !== 'string' || !HASH.test(v.receipt_hash)) return downloadUnresolved();
  return Object.freeze({ ...v }) as DownloadSeal;
}
export function parseDownloadEvidence(seal: DownloadSeal): DownloadEvidence {
  let v: any; try { v = JSON.parse(seal.evidence_json); } catch { return downloadUnresolved(); }
  if (!downloadExact(v, ['protocol','disposition','operation_id','input_hash','recorded_at','context','ticket_id','expected','ticket','wire']) ||
      v.protocol !== 'lovelies-download-evidence-v2' || !['issued','not_issued'].includes(v.disposition) || !UUID.test(v.operation_id) ||
      !Number.isSafeInteger(v.recorded_at) || v.recorded_at<0 || !UUID.test(v.ticket_id) || !HASH.test(v.input_hash) || stable(v) !== seal.evidence_json) return downloadUnresolved();
  validateDownloadContext(v.context);
  const m = v.expected;
  if (!downloadExact(m,['database_id','incarnation_id','checkpoint','cursor']) || !UUID.test(m.database_id) || !UUID.test(m.incarnation_id) ||
      !downloadExact(m.checkpoint,['revision','hash']) || !downloadExact(m.cursor,['sequence','hash']) ||
      !Number.isSafeInteger(m.checkpoint.revision) || m.checkpoint.revision < 0 || !HASH.test(m.checkpoint.hash) ||
      !Number.isSafeInteger(m.cursor.sequence) || m.cursor.sequence < 0 || !HASH.test(m.cursor.hash) ||
      m.cursor.sequence === 0 && m.cursor.hash !== '0'.repeat(64)) return downloadUnresolved();
  if (v.disposition === 'not_issued' ? v.ticket !== null : !downloadExact(v.ticket,
      ['id','created_at','expires_at','source_checksum','object_key','content_type','byte_size','subscription_id','subscription_version','authority','admission','session'])) return downloadUnresolved();
  if (v.ticket && (v.ticket.id !== v.ticket_id || v.ticket.created_at!==v.recorded_at || !Number.isSafeInteger(v.ticket.created_at) || v.ticket.created_at < 0 ||
      !Number.isSafeInteger(v.ticket.expires_at) || v.ticket.expires_at <= v.ticket.created_at || v.ticket.expires_at - v.ticket.created_at > 120000 ||
      !Number.isSafeInteger(v.ticket.byte_size) || v.ticket.byte_size < 1 || v.ticket.byte_size > DOWNLOAD_MAX_BYTES ||
      !HASH.test(v.ticket.source_checksum) || !UUID.test(v.ticket.subscription_id) || !Number.isSafeInteger(v.ticket.subscription_version) ||
      v.ticket.subscription_version < 1 || typeof v.ticket.object_key !== 'string' || !v.ticket.object_key || v.ticket.object_key.length > 1024 ||
      !['image/jpeg','image/png','image/webp','image/gif'].includes(v.ticket.content_type))) return downloadUnresolved();
  if (stable(v.wire) !== stable(downloadWire(v.context,v.ticket))) return downloadUnresolved();
  return v as DownloadEvidence;
}
export function validateDownloadDescriptor(v: unknown): DownloadDescriptor {
  if (!downloadExact(v, ['kind','context','ticket_id','issued_receipt_hash','not_issued']) || v.kind !== 'download-issuance-v2' ||
      !UUID.test(v.ticket_id) || !HASH.test(v.issued_receipt_hash)) return downloadUnresolved();
  return Object.freeze({ kind: v.kind, context: validateDownloadContext(v.context), ticket_id: v.ticket_id,
    issued_receipt_hash: v.issued_receipt_hash, not_issued: validateDownloadSeal(v.not_issued) });
}
export async function verifyDownloadDescriptor(raw: unknown, identity: { operation_id: string; input_hash: string;
  allocations: Readonly<Record<string,string>>; expected: RestoreMarker; events: readonly unknown[] }): Promise<DownloadDescriptor> {
  const d = validateDownloadDescriptor(raw), e = parseDownloadEvidence(d.not_issued);
  if (identity.events.length !== 0 || stable(identity.allocations) !== stable({ id_0: d.ticket_id }) ||
      identity.operation_id !== await restoreOperationID(d.context.account_id, DOWNLOAD_SOURCE, d.context.operation_key) ||
      d.ticket_id !== await restoreAllocationID(identity.operation_id,'id_0') || identity.input_hash !== await digest(stable(d.context)) ||
      e.disposition !== 'not_issued' || e.operation_id !== identity.operation_id || e.input_hash !== identity.input_hash ||
      e.ticket_id !== d.ticket_id || stable(e.context) !== stable(d.context) || stable(e.expected) !== stable(identity.expected) ||
      d.not_issued.receipt_hash !== await sealHash(d.not_issued)) return downloadUnresolved();
  return d;
}
async function sealHash(v: DownloadSeal): Promise<string> {
  return digest(stable({ key_id: v.key_id, evidence_json: v.evidence_json, mac_sha256: v.mac_sha256 }));
}
function keyRing(config: DownloadKeyConfiguration): { current: string; keys: Record<string,string> } {
  if (!config.DOWNLOAD_RECEIPT_KEY_ID && !config.DOWNLOAD_RECEIPT_KEYS_JSON) {
    if (typeof config.MEDIA_SIGNING_SECRET!=='string' || config.MEDIA_SIGNING_SECRET.length<32) return downloadUnresolved();
    return {current:'media-v2',keys:{}};
  }
  let keys: unknown; try { keys = JSON.parse(config.DOWNLOAD_RECEIPT_KEYS_JSON ?? ''); } catch { return downloadUnresolved(); }
  const current = config.DOWNLOAD_RECEIPT_KEY_ID;
  if (typeof current !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(current) || !keys || typeof keys !== 'object' || Array.isArray(keys) ||
      Object.getPrototypeOf(keys) !== Object.prototype || Object.keys(keys).length < 1 || Object.keys(keys).length > 8 ||
      Object.entries(keys).some(([id,k]) => (id==='media-v2' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) || typeof k !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(k)) ||
      !Object.hasOwn(keys,current)) return downloadUnresolved();
  return { current, keys: keys as Record<string,string> };
}
async function mac(config: DownloadKeyConfiguration, id: string, evidence: string): Promise<string> {
  const encoded = keyRing(config).keys[id];
  let raw:Uint8Array;
  if (id==='media-v2' && typeof config.MEDIA_SIGNING_SECRET==='string' && config.MEDIA_SIGNING_SECRET.length>=32) {
    const source=new TextEncoder().encode(config.MEDIA_SIGNING_SECRET);
    try {const material=await crypto.subtle.importKey('raw',source.buffer,'HKDF',false,['deriveBits']);
      raw=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode('ltqfplqevxztlswlzexn'),info:new TextEncoder().encode('lovelies-download-receipt-key-v2')},material,256));
    }finally{source.fill(0);}
  } else {
    if (!encoded) return downloadUnresolved();
    raw = Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/') + '='), c => c.charCodeAt(0));
  }
  const owned=new Uint8Array(raw);
  try { const key = await crypto.subtle.importKey('raw',owned.buffer,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('lovelies-download-evidence-v2\n'+evidence)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  } finally { owned.fill(0);raw.fill(0); }
}
export async function sealDownloadEvidence(config: DownloadKeyConfiguration, evidence: DownloadEvidence): Promise<DownloadSeal> {
  const key_id = keyRing(config).current, evidence_json = stable(evidence), mac_sha256 = await mac(config,key_id,evidence_json);
  const seal = { key_id, evidence_json, mac_sha256, receipt_hash: '' }; seal.receipt_hash = await sealHash(seal);
  parseDownloadEvidence(seal); return Object.freeze(seal);
}
export async function verifyDownloadSeal(config: DownloadKeyConfiguration, raw: unknown): Promise<DownloadEvidence> {
  const seal = validateDownloadSeal(raw), expected = await mac(config,seal.key_id,seal.evidence_json);
  // Fixed-width, full comparison; do not expose which field/key failed.
  let difference = 0; for (let i=0;i<64;i++) difference |= expected.charCodeAt(i)^seal.mac_sha256.charCodeAt(i);
  if (difference !== 0 || seal.receipt_hash !== await sealHash(seal)) return downloadUnresolved();
  return parseDownloadEvidence(seal);
}
