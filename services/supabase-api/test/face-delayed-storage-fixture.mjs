/** Pure synthetic Storage transport. No fetch/network/provider or file I/O. */
import assert from 'node:assert/strict';
import {SupabasePrivateBucket} from '../src/storage.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

export function delayedFaceStorage(memory,{bucket,prefix,mode}){
 assert(['photos','quarantine'].includes(bucket));assert(['ambiguous','acknowledged'].includes(mode));
 assert.equal(typeof prefix,'string');assert(prefix.length>0);const origin='http://127.0.0.1:1',gate=deferred(),events=[],writes=[];
 const allowedKey=key=>assert(key.startsWith(prefix)&&!key.includes('..'),'synthetic fixture denies an unrelated key');
 const keyFrom=(path,start)=>{assert(path.startsWith(start),'unexpected synthetic route');const value=path.slice(start.length).split('/').map(decodeURIComponent).join('/');allowedKey(value);return value;};
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method??'GET').toUpperCase();assert.equal(url.origin,origin);assert.equal(url.search,'');
  const headers=new Headers(init.headers);assert.equal(headers.get('apikey'),'synthetic-face-local-only');assert.equal(headers.get('authorization'),null);
  if(method==='POST'&&url.pathname.startsWith('/storage/v1/object/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/'+bucket+'/');assert.equal(headers.get('x-upsert'),'false');
   const bytes=init.body instanceof Uint8Array?new Uint8Array(init.body):new Uint8Array(init.body).slice();
   const metadata=JSON.parse(Buffer.from(headers.get('x-metadata')??'e30=','base64').toString('utf8'));
   const options={customMetadata:metadata,httpMetadata:{contentType:headers.get('content-type')??'application/octet-stream'}};
   events.push({kind:'put-dispatched',key});
   if(mode==='ambiguous'){
    const remote=gate.promise.then(async()=>{events.push({kind:'remote-write',key});await memory.put(key,bytes,options);bytes.fill(0);});
    writes.push({key,remote});void remote.catch(()=>{});throw Error('synthetic locally rejected face write with unknown remote outcome');
   }
   await memory.put(key,bytes,options);bytes.fill(0);events.push({kind:'remote-write',key});writes.push({key,remote:Promise.resolve()});
   return Response.json({Key:bucket+'/'+key,Id:'synthetic-face-acknowledgement'});
  }
  if(method==='DELETE'&&url.pathname==='/storage/v1/object/'+bucket){
   const value=JSON.parse(String(init.body));assert(Array.isArray(value.prefixes)&&value.prefixes.length<=16);
   for(const key of value.prefixes){allowedKey(key);assert(writes.some(w=>w.key===key),'synthetic DELETE must name a dispatched fixture key');events.push({kind:'delete',key});await memory.delete(key);}
   return new Response(null,{status:200});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/info/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/info/'+bucket+'/');events.push({kind:'head',key});const value=await memory.head(key);
   if(!value)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});return Response.json({size:value.size,etag:value.etag,content_type:value.httpMetadata?.contentType??'application/octet-stream',metadata:value.customMetadata});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/authenticated/'+bucket+'/');events.push({kind:'get',key});const value=await memory.get(key);
   if(!value)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});return new Response(await value.arrayBuffer(),{status:200,headers:{etag:'"'+value.etag+'"'}});
  }
  throw Error('unexpected synthetic face Storage method/route');
 };
 return {bucket:new SupabasePrivateBucket(origin,'synthetic-face-local-only',bucket,fetcher),events,writes,
  release:async()=>{gate.resolve();await Promise.all(writes.map(w=>w.remote));}};
}
