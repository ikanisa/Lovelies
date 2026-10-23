import { ApiError, type PrivateBucket, type PrivateObject } from './types.ts';

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
    if(response.redirected||response.status>=300&&response.status<400)throw new ApiError(503,'storage_redirect_denied');
    if(!response.ok&&response.status!==404){await response.body?.cancel();throw new ApiError(503,'private_storage_unavailable');}
    return response;
  }
  async head(key:string):Promise<Omit<PrivateObject,'body'|'arrayBuffer'>|null>{
    const response=await this.request('/object/info/'+this.path(key));if(response.status===404){await response.body?.cancel();return null;}
    const object=await response.json() as Record<string,any>;
    const metadata=object.metadata??{},user=object.user_metadata??object.userMetadata??object.metadata??{};
    const size=Number(object.size??metadata.size),etag=String(object.etag??object.eTag??metadata.eTag??metadata.etag??object.version??'');
    if(!Number.isSafeInteger(size)||size<0||!etag||!user||typeof user!=='object'||Array.isArray(user))throw new ApiError(503,'private_storage_metadata_invalid');
    return {size,etag:etag.replace(/^"|"$/g,''),customMetadata:user,httpMetadata:{contentType:String(object.content_type??object.contentType??object.mimetype??metadata.mimetype??'application/octet-stream')}};
  }
  async get(key:string):Promise<PrivateObject|null>{
    const initial=await this.head(key);if(!initial)return null;
    const response=await this.request('/object/authenticated/'+this.path(key));if(response.status===404){await response.body?.cancel();return null;}
    const downloadEtag=response.headers.get('etag')?.replace(/^W\//,'').replace(/^"|"$/g,'');
    if(downloadEtag&&downloadEtag!==initial.etag){await response.body?.cancel();throw new ApiError(409,'private_object_changed');}
    return {...initial,body:response.body,arrayBuffer:()=>response.arrayBuffer()};
  }
  async put(key:string,value:ArrayBuffer|Uint8Array,options:Parameters<PrivateBucket['put']>[2]={}):Promise<void>{
    const metadata=options?.customMetadata??{};
    const encoded=btoa(JSON.stringify(metadata));
    const response=await this.request('/object/'+this.path(key),{method:'POST',headers:{'Content-Type':options?.httpMetadata?.contentType??'application/octet-stream','Cache-Control':'no-store','x-upsert':'false','x-metadata':encoded},body:new Uint8Array(value instanceof ArrayBuffer?value:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)) as unknown as BodyInit});
    if(!response.ok)throw new ApiError(503,'private_storage_write_failed');
    await response.body?.cancel();
  }
  async delete(keys:string|string[]):Promise<void>{
    const names=typeof keys==='string'?[keys]:keys;if(!names.length)return;for(const key of names)this.path(key);
    const response=await this.request('/object/'+this.bucket,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:names})});await response.body?.cancel();
  }
}
