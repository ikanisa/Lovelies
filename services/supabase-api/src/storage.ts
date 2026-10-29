import { ApiError, jsonBody, type PrivateBucket, type PrivateObject } from './types.ts';

const MAX_STORAGE_ERROR_BYTES=2048;
const MAX_STORAGE_ERROR_CHUNKS=256;
const STORAGE_ERROR_TIMEOUT_MS=1000;
const STORAGE_PUT_CLEANUP_TIMEOUT_MS=1000;
// Applies only when the caller explicitly identifies a read-only preview.
const MAX_PREVIEW_INFO_BYTES=8*1024*1024;

/** A rejected read can return without waiting for response-body cleanup. */
function discardResponseBody(response:Response):void {
  try{void response.body?.cancel().catch(()=>{});}catch{}
}

/** Bound only the local cleanup wait. A failed or timed-out cancellation says
 * nothing about the remote write: callers must retain its pending intent. An
 * ordinary completed cancellation preserves the existing response handling;
 * it does not establish provider acknowledgement or writer terminality. */
async function finishPutResponse(response:Response):Promise<void> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    if (!response.body) return;
    const cancellation=response.body.cancel();
    if (!cancellation || typeof cancellation.then!=='function') throw new Error('storage_put_cleanup_invalid');
    const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('storage_put_cleanup_timeout')),STORAGE_PUT_CLEANUP_TIMEOUT_MS);});
    await Promise.race([cancellation,expired]);
  } catch {
    throw new ApiError(503,'private_storage_write_failed');
  } finally {
    if(timer!==undefined)clearTimeout(timer);
  }
}

/** storage-api v1.68.10 uses HTTP 400 for this specific missing-key error.
 * An arbitrary 400, denied credential or malformed error is never absence. */
async function missingObjectEnvelope(response:Response):Promise<boolean>{
  const type=response.headers.get('content-type')??'',length=response.headers.get('content-length');
  if(!/^application\/json(?:;|$)/i.test(type)||length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_STORAGE_ERROR_BYTES)||!response.body)return false;
  let reader:ReadableStreamDefaultReader<Uint8Array>;
  try{reader=response.body.getReader();}catch{return false;}
  const buffer=new Uint8Array(MAX_STORAGE_ERROR_BYTES);let bytes=0,chunks=0,timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('storage_error_body_timeout')),STORAGE_ERROR_TIMEOUT_MS);});
  try{
    for(;;){
      const next=await Promise.race([reader.read(),expired]);if(next.done)break;
      if(++chunks>MAX_STORAGE_ERROR_CHUNKS||bytes+next.value.byteLength>MAX_STORAGE_ERROR_BYTES)return false;
      buffer.set(next.value,bytes);bytes+=next.value.byteLength;
    }
    if(length!==null&&Number(length)!==bytes)return false;
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes))) as Record<string,unknown>;
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&
      value.statusCode==='404'&&value.error==='not_found'&&value.code==='NoSuchKey'&&value.message==='Object not found';
  }catch{return false;}
  finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Storage credentials remain server-only. All end-user reads pass the app's
 * current-session/grant checks; no public or signed Storage URL escapes. */
export class SupabasePrivateBucket implements PrivateBucket {
  private readonly base:string;
  constructor(projectUrl:string,private readonly secret:string,private readonly bucket:string,private readonly fetcher:typeof fetch=fetch){
    const url=new URL(projectUrl);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname)))throw new Error('HTTPS Storage required');
    this.base=url.origin+'/storage/v1';
    if(!/^[a-z0-9-]+$/.test(bucket)||!secret)throw new Error('Storage configuration missing');
  }
  private path(key:string):string {
    if(!key||key.startsWith('/')||key.split('/').some(part=>!part||part==='.'||part==='..')||key.includes('\\')||/[\u0000-\u001f]/.test(key))throw new ApiError(500,'invalid_private_object_key');
    return this.bucket+'/'+key.split('/').map(encodeURIComponent).join('/');
  }
  private async request(path:string,init:RequestInit={}):Promise<Response>{
    const headers=new Headers(init.headers);headers.set('apikey',this.secret);
    // New sb_secret keys are apikeys, not JWTs; legacy service_role is a JWT.
    if(this.secret.split('.').length===3)headers.set('Authorization','Bearer '+this.secret);
    const response=await this.fetcher(this.base+path,{...init,headers,redirect:'manual'});
    if(response.redirected||response.status>=300&&response.status<400){discardResponseBody(response);throw new ApiError(503,'storage_redirect_denied');}
    const objectRead=(init.method??'GET')==='GET'&&(path.startsWith('/object/info/')||path.startsWith('/object/authenticated/'));
    if(response.status===400&&objectRead&&await missingObjectEnvelope(response))return new Response(null,{status:404});
    // Only the classified object-read envelope above may become absence. A
    // native 404 can instead be an unknown bucket or route, including DELETE.
    if(!response.ok){
      discardResponseBody(response);
      // Preserve the existing write-error code for a rejected POST 404.
      throw new ApiError(503,init.method==='POST'&&response.status===404?'private_storage_write_failed':'private_storage_unavailable');
    }
    return response;
  }
  async head(key:string,options?:{metadataBody?:'preview-read'}):Promise<Omit<PrivateObject,'body'|'arrayBuffer'>|null>{
    const response=await this.request('/object/info/'+this.path(key));if(response.status===404){void response.body?.cancel().catch(()=>{});return null;}
    let object:Record<string,any>;
    if(options?.metadataBody==='preview-read'){
      try{object=await jsonBody(response,MAX_PREVIEW_INFO_BYTES);}
      catch{discardResponseBody(response);throw new ApiError(503,'private_storage_metadata_invalid');}
    }else object=await response.json() as Record<string,any>;
    const metadata=object.metadata??{},user=object.user_metadata??object.userMetadata??object.metadata??{};
    const size=Number(object.size??metadata.size),etag=String(object.etag??object.eTag??metadata.eTag??metadata.etag??object.version??'');
    if(!Number.isSafeInteger(size)||size<0||!etag||!user||typeof user!=='object'||Array.isArray(user))throw new ApiError(503,'private_storage_metadata_invalid');
    return {size,etag:etag.replace(/^"|"$/g,''),customMetadata:user,httpMetadata:{contentType:String(object.content_type??object.contentType??object.mimetype??metadata.mimetype??'application/octet-stream')}};
  }
  async get(key:string):Promise<PrivateObject|null>{
    const initial=await this.head(key);if(!initial)return null;
    const response=await this.request('/object/authenticated/'+this.path(key));if(response.status===404){void response.body?.cancel().catch(()=>{});return null;}
    const downloadEtag=response.headers.get('etag')?.replace(/^W\//,'').replace(/^"|"$/g,'');
    if(downloadEtag&&downloadEtag!==initial.etag){discardResponseBody(response);throw new ApiError(409,'private_object_changed');}
    return {...initial,body:response.body,arrayBuffer:()=>response.arrayBuffer()};
  }
  async put(key:string,value:ArrayBuffer|Uint8Array,options:Parameters<PrivateBucket['put']>[2]={}):Promise<void>{
    const metadata=options?.customMetadata??{};
    const encoded=btoa(JSON.stringify(metadata));
    const response=await this.request('/object/'+this.path(key),{method:'POST',headers:{'Content-Type':options?.httpMetadata?.contentType??'application/octet-stream','Cache-Control':'no-store','x-upsert':'false','x-metadata':encoded},body:new Uint8Array(value instanceof ArrayBuffer?value:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)) as unknown as BodyInit});
    if(!response.ok)throw new ApiError(503,'private_storage_write_failed');
    await finishPutResponse(response);
  }
  async delete(keys:string|string[]):Promise<void>{
    const names=typeof keys==='string'?[keys]:keys;if(!names.length)return;for(const key of names)this.path(key);
    const response=await this.request('/object/'+this.bucket,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:names})});await response.body?.cancel();
  }
}
