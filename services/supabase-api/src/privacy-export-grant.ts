import { base64url, decodeBase64url } from './auth.ts';
import { ApiError, digest, stable, type AppContext } from './types.ts';

export const EXPORT_GRANT_PROTOCOL = 'lovelies-privacy-export-grant-v1';
export const EXPORT_GRANT_INPUT_PROTOCOL = 'lovelies-privacy-export-grant-input-v1';
export type GrantReceipt = {
    protocol:string; operation_key:string; account_id:string; session_id:string; request_id:string;
    grant_id:string; token_hash:string; created_at:number; expires_at:number; iv:string; ciphertext:string;
};
export type GrantOperationRow = {action:string;payload_hash:string;payload_json:string;response_json:string};
const encoder = new TextEncoder();
const canonicalUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function grantUnavailable(): never { throw new ApiError(503,'privacy_export_grant_reconciliation_required'); }
export function grantExpired(): never { throw new ApiError(410,'privacy_export_grant_unavailable'); }
/** Only an intact authenticated receipt and matching row can prove this. */
export function grantReceiptExpired(): never { throw new ApiError(410,'privacy_export_grant_expired'); }
export async function exportGrantKey(ctx: AppContext): Promise<CryptoKey> {
    const secret=ctx.env.AUTH_SIGNING_SECRET;
    if(typeof secret!=='string'||encoder.encode(secret).length<32)return grantUnavailable();
    const bytes=encoder.encode(secret);
    try {
        const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);
        return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',
            salt:encoder.encode('lovelies-supabase/privacy-export-grant/v1'),
            info:encoder.encode('one-use-grant/AES-256-GCM')},material,
            {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    } finally { bytes.fill(0); }
}
export function grantAAD(receipt: Omit<GrantReceipt,'iv'|'ciphertext'>): Uint8Array<ArrayBuffer> {
    return encoder.encode(stable(receipt));
}
function binding(receipt: GrantReceipt): Omit<GrantReceipt,'iv'|'ciphertext'> {
    const {iv:_iv,ciphertext:_ciphertext,...rest}=receipt;return rest;
}
/** Authenticate the complete stored envelope and its input; callers separately
 * check live session, grant use and publication before releasing the bearer. */
export async function verifiedGrantReceipt(ctx: AppContext, accountId: string, key: string, row: GrantOperationRow): Promise<{receipt:GrantReceipt;token:string}> {
    if(row.action!=='privacy.export.grant'||typeof row.payload_hash!=='string'||!/^[0-9a-f]{64}$/.test(row.payload_hash)||
        typeof row.payload_json!=='string'||row.payload_json.length>4096||typeof row.response_json!=='string'||row.response_json.length>4096)return grantUnavailable();
    let parsedInput:unknown,parsedResult:unknown;
    try { parsedInput=JSON.parse(row.payload_json);parsedResult=JSON.parse(row.response_json); } catch { return grantUnavailable(); }
    if(!parsedInput||typeof parsedInput!=='object'||Array.isArray(parsedInput)||!parsedResult||typeof parsedResult!=='object'||Array.isArray(parsedResult))return grantUnavailable();
    const input=parsedInput as Record<string,unknown>,value=parsedResult as Record<string,unknown>;
    if(Object.keys(input).sort().join(',')!=='operation_key,protocol,request_id,session_id'||input.protocol!==EXPORT_GRANT_INPUT_PROTOCOL||input.operation_key!==key||
        typeof input.request_id!=='string'||!canonicalUUID.test(input.request_id)||typeof input.session_id!=='string'||!canonicalUUID.test(input.session_id)||
        Object.keys(value).sort().join(',')!=='account_id,ciphertext,created_at,expires_at,grant_id,iv,operation_key,protocol,request_id,session_id,token_hash'||
        value.protocol!==EXPORT_GRANT_PROTOCOL||value.operation_key!==key||value.account_id!==accountId||value.session_id!==input.session_id||value.request_id!==input.request_id||
        typeof value.grant_id!=='string'||!canonicalUUID.test(value.grant_id)||typeof value.token_hash!=='string'||!/^[0-9a-f]{64}$/.test(value.token_hash)||
        typeof value.iv!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(value.iv)||typeof value.ciphertext!=='string'||!/^[A-Za-z0-9_-]{79}$/.test(value.ciphertext)||
        !Number.isSafeInteger(value.created_at)||!Number.isSafeInteger(value.expires_at)||Number(value.expires_at)<=Number(value.created_at)||
        Number(value.expires_at)>Number(value.created_at)+300000||stable(input)!==row.payload_json||stable(value)!==row.response_json||
        await digest(stable({action:row.action,source:'privacy',payload:input}))!==row.payload_hash)return grantUnavailable();
    const receipt=value as GrantReceipt,keyMaterial=await exportGrantKey(ctx);
    let iv:Uint8Array,cipher:Uint8Array;
    try { iv=decodeBase64url(receipt.iv,12);cipher=decodeBase64url(receipt.ciphertext,59); }
    catch { return grantUnavailable(); }
    if(iv.length!==12||cipher.length!==59)return grantUnavailable();
    let plain:Uint8Array|undefined;
    try {
        plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv).buffer,
            additionalData:grantAAD(binding(receipt))},keyMaterial,new Uint8Array(cipher).buffer));
        const token=new TextDecoder('utf-8',{fatal:true}).decode(plain);
        if(!/^[A-Za-z0-9_-]{43}$/.test(token)||await digest(token)!==receipt.token_hash)return grantUnavailable();
        return {receipt,token};
    } catch(error) {
        if(error instanceof ApiError)throw error;
        return grantUnavailable();
    } finally { plain?.fill(0); }
}
