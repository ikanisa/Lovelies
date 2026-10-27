/** In-memory transport only; no native fetch, socket, credentials or provider. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SupabasePrivateBucket} from '../src/storage.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function delayedPrivateMedia(memory,{bucket,prefix,mode}){
 assert(['photos','privacy-exports'].includes(bucket));assert(['ambiguous','acknowledged'].includes(mode));
 assert(typeof prefix==='string'&&prefix.length>0);const initial=new Set(memory.rows.keys()),gate=deferred(),events=[],writes=[];
 const origin='http://127.0.0.1:1',secret='synthetic-private-media-only';
 const target=key=>key.startsWith(prefix)&&!key.split('/').some(part=>!part||part==='.'||part==='..');
 const known=key=>target(key)||initial.has(key);
 const keyFrom=(pathname,start)=>{assert(pathname.startsWith(start));const key=pathname.slice(start.length).split('/').map(decodeURIComponent).join('/');assert(known(key),'fixture rejects unrelated in-memory resource');return key;};
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method??'GET').toUpperCase();assert.equal(url.origin,origin);assert.equal(url.search,'');
  const headers=new Headers(init.headers);assert.equal(headers.get('apikey'),secret);assert.equal(headers.get('authorization'),null);
  if(method==='POST'&&url.pathname.startsWith('/storage/v1/object/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/'+bucket+'/');assert(target(key));assert.equal(writes.length,0,'one targeted producer dispatch only');assert.equal(headers.get('x-upsert'),'false');
   const bytes=init.body instanceof Uint8Array?new Uint8Array(init.body):new Uint8Array(init.body).slice();
   const metadata=JSON.parse(Buffer.from(headers.get('x-metadata')??'e30=','base64').toString('utf8'));
   const options={customMetadata:metadata,httpMetadata:{contentType:headers.get('content-type')??'application/octet-stream'}};
   const write={key,sha256:digest(bytes),size:bytes.length,metadata,remote:null};writes.push(write);events.push({kind:'put-dispatched',key});
   const commit=async()=>{try{await memory.put(key,bytes,options);events.push({kind:'remote-commit',key});}finally{bytes.fill(0);}};
   if(mode==='ambiguous'){write.remote=gate.promise.then(commit);void write.remote.catch(()=>{});throw Error('synthetic rejected write with independently delayed remote effect');}
   write.remote=commit();await write.remote;return Response.json({Id:crypto.randomUUID(),Key:bucket+'/'+key});
  }
  if(method==='DELETE'&&url.pathname==='/storage/v1/object/'+bucket){
   const body=JSON.parse(String(init.body));assert(Array.isArray(body.prefixes)&&body.prefixes.length>=1&&body.prefixes.length<=64);
   for(const key of body.prefixes){assert(known(key));assert(initial.has(key)||writes.some(w=>w.key===key),'DELETE must name an owned initial or dispatched key');events.push({kind:'delete',key});await memory.delete(key);}
   return new Response(null,{status:200});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/info/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/info/'+bucket+'/');events.push({kind:'head',key});const value=await memory.head(key);if(!value)return new Response(null,{status:404});
   return Response.json({size:value.size,etag:value.etag,content_type:value.httpMetadata?.contentType??'application/octet-stream',metadata:value.customMetadata});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/'+bucket+'/')){
   const key=keyFrom(url.pathname,'/storage/v1/object/authenticated/'+bucket+'/');events.push({kind:'get',key});const value=await memory.get(key);if(!value)return new Response(null,{status:404});return new Response(await value.arrayBuffer(),{headers:{etag:'"'+value.etag+'"'}});
  }
  throw Error('unexpected synthetic private-media Storage route');
 };
 return {bucket:new SupabasePrivateBucket(origin,secret,bucket,fetcher),memory,events,writes,mark:label=>events.push({kind:label}),release:async()=>{gate.resolve();await Promise.all(writes.map(w=>w.remote));}};
}
/** Observe completed real reads without changing SQL/results or adding DB work. */
export function observeWriterChecks(db,target){
 const original=db.one;let completed=0;
 db.one=function(sql,...bindings){const watched=typeof sql==='string'&&sql.includes('media_write_intents')&&sql.includes("status='pending'")&&bindings.includes(target);return original.call(this,sql,...bindings).then(value=>{if(watched)completed++;return value;});};
 return {count:()=>completed,restore:()=>{db.one=original;}};
}
