import { ApiError, type ServiceFetcher } from './types.ts';

/** Pins private destinations to deployment configuration; callers can provide
 * paths and bodies but cannot redirect the adapter to arbitrary hosts. */
export class AuthenticatedService implements ServiceFetcher {
  private readonly base:URL;
  constructor(url:string,private readonly token:string,private readonly fetcher:typeof fetch=fetch,private readonly timeoutMs=55_000){
    this.base=new URL(url);
    const permitted=this.base.protocol==='https:'||this.base.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(this.base.hostname);
    if(this.base.username||this.base.password||this.base.search||this.base.hash||!permitted||token.length<32||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>55_000)throw new Error('Private service requires a pinned HTTPS URL, bounded timeout and secret');
  }
  async fetch(input:Request|string|URL,init?:RequestInit):Promise<Response>{
    const source=input instanceof Request?new Request(input,init):new Request(input,init);
    const path=new URL(source.url),destination=new URL(this.base);
    destination.pathname=this.base.pathname.replace(/\/$/,'')+path.pathname;destination.search=path.search;
    const headers=new Headers(source.headers);headers.set('Authorization','Bearer '+this.token);
    const controller=new AbortController(),forwardAbort=()=>controller.abort(source.signal.reason);
    const timer=setTimeout(()=>controller.abort(new ApiError(503,'private_service_timeout')),this.timeoutMs);
    source.signal.addEventListener('abort',forwardAbort,{once:true});
    if(source.signal.aborted)forwardAbort();
    const aborted=new Promise<never>((_,reject)=>{
      const stop=()=>reject(controller.signal.reason??new ApiError(503,'private_service_aborted'));
      controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();
    });
    const finish=()=>{clearTimeout(timer);source.signal.removeEventListener('abort',forwardAbort);};
    try{
      const response=await Promise.race([this.fetcher(new Request(destination,new Request(source,{headers,redirect:'manual',signal:controller.signal}))),aborted]);
      if(response.redirected||response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});throw new ApiError(503,'private_service_redirect_denied');}
      if(!response.body){finish();return response;}
      const reader=response.body.getReader();
      // Keep the same deadline through response consumption, not only headers.
      const body=new ReadableStream<Uint8Array>({
        pull:async output=>{try{const next=await Promise.race([reader.read(),aborted]);if(next.done){finish();output.close();}else output.enqueue(next.value);}catch(error){finish();void reader.cancel(error).catch(()=>{});output.error(error);}},
        cancel:async reason=>{try{await reader.cancel(reason);}finally{finish();}},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){finish();throw error;}
  }
}
