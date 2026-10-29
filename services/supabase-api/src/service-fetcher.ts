import { ApiError, type ServiceFetcher } from './types.ts';
import {INFERENCE_LIMITS,INFERENCE_REPLY_BYTES} from './inference-contract.ts';

interface BodyLimits {requestBytes:number;responseBytes:number;}

// Error and late-reply teardown is best effort. A synchronous throw, rejected
// promise or never-settling cancel must not replace the existing decision.
function discard(cancel:()=>unknown):void {
  try{void Promise.resolve(cancel()).catch(()=>{});}catch{}
}

/** Pins private destinations to deployment configuration; callers can provide
 * paths and bodies but cannot redirect the adapter to arbitrary hosts. */
export class AuthenticatedService implements ServiceFetcher {
  private readonly base:URL;
  constructor(url:string,private readonly token:string,private readonly fetcher:typeof fetch=fetch,private readonly timeoutMs=55_000,
    private readonly limits:BodyLimits={requestBytes:INFERENCE_LIMITS.photo_body_bytes,responseBytes:INFERENCE_REPLY_BYTES}){
    this.base=new URL(url);
    const permitted=this.base.protocol==='https:'||this.base.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(this.base.hostname);
    if(this.base.username||this.base.password||this.base.search||this.base.hash||!permitted||token.length<32||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>55_000||
      !Number.isSafeInteger(limits.requestBytes)||limits.requestBytes<1||limits.requestBytes>INFERENCE_LIMITS.photo_body_bytes||
      !Number.isSafeInteger(limits.responseBytes)||limits.responseBytes<1||limits.responseBytes>INFERENCE_REPLY_BYTES)
      throw new Error('Private service requires a pinned HTTPS URL, bounded timeout/body and secret');
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
    const abortReason=()=>controller.signal.reason??new ApiError(503,'private_service_aborted');
    const aborted=new Promise<never>((_,reject)=>{
      const stop=()=>reject(abortReason());
      controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();
    });
    // Validation can stop before the fetch race is attached. Cancellation must
    // still be observed when an oversized/invalid request takes that path.
    void aborted.catch(()=>{});
    const finish=()=>{clearTimeout(timer);source.signal.removeEventListener('abort',forwardAbort);};
    try{
      // A caller that is already cancelled must not dispatch an external call.
      if(controller.signal.aborted)throw abortReason();
      const claimed=source.headers.get('content-length');
      if(claimed&&/^\d+$/.test(claimed)&&Number(claimed)>this.limits.requestBytes)throw new ApiError(413,'private_service_request_too_large');
      let requestBytes=0;
      const limited=source.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
        transform:(chunk,output)=>{requestBytes+=chunk.byteLength;if(requestBytes>this.limits.requestBytes)throw new ApiError(413,'private_service_request_too_large');output.enqueue(chunk);},
      }));
      const forwarded=new Request(destination,{method:source.method,headers,redirect:'manual',signal:controller.signal,
        ...(limited?{body:limited,duplex:'half'}:{})} as RequestInit);
      const pending=this.fetcher(forwarded);
      let replyDiscarded=false;
      const discardReply=(reply:Response)=>{if(!replyDiscarded){replyDiscarded=true;discard(()=>reply.body?.cancel());}};
      void pending.then(late=>{if(controller.signal.aborted)discardReply(late);},()=>{});
      const response=await Promise.race([pending,aborted]);
      // Both promises may already be settled when the race is registered.
      if(controller.signal.aborted){discardReply(response);throw abortReason();}
      if(response.redirected||response.status>=300&&response.status<400){discardReply(response);throw new ApiError(503,'private_service_redirect_denied');}
      const replyLength=response.headers.get('content-length');
      if(replyLength&&/^\d+$/.test(replyLength)&&Number(replyLength)>this.limits.responseBytes){discardReply(response);throw new ApiError(503,'private_service_response_too_large');}
      if(!response.body){finish();return response;}
      const reader=response.body.getReader();let responseBytes=0,terminal=false;
      let abortBody:()=>void;
      const finishBody=()=>{controller.signal.removeEventListener('abort',abortBody);finish();};
      // Keep the same deadline through response consumption, not only headers.
      const body=new ReadableStream<Uint8Array>({
        start:output=>{
          // Erroring the wrapper also discards bytes it had already buffered.
          abortBody=()=>{if(terminal)return;terminal=true;const error=abortReason();finishBody();discard(()=>reader.cancel(error));output.error(error);};
          controller.signal.addEventListener('abort',abortBody,{once:true});
          if(controller.signal.aborted)abortBody();
        },
        pull:async output=>{
          try{
            const next=await Promise.race([reader.read(),aborted]);
            if(terminal)return;
            if(controller.signal.aborted)throw abortReason();
            if(next.done){terminal=true;finishBody();output.close();}
            else{responseBytes+=next.value.byteLength;if(responseBytes>this.limits.responseBytes)throw new ApiError(503,'private_service_response_too_large');output.enqueue(next.value);}
          }catch(error){if(terminal)return;terminal=true;finishBody();controller.abort(error);discard(()=>reader.cancel(error));output.error(error);}
        },
        cancel:async reason=>{terminal=true;controller.signal.removeEventListener('abort',abortBody);controller.abort(reason);try{await reader.cancel(reason);}finally{finish();}},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){
      // If cancellation was already observed, preserve it even when a
      // simultaneously settled fetch rejection wins the promise race.
      const finalError=controller.signal.aborted?abortReason():error;
      finish();controller.abort(finalError);discard(()=>{if(source.body&&!source.body.locked)return source.body.cancel(finalError);});throw finalError;
    }
  }
}
