/** Real local Supabase Storage HTTP, never a memory Storage substitute.
 * The small loopback proxy only supplies the gateway's /storage/v1 prefix.
 * Storage credentials remain within this test process. */
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {SupabasePrivateBucket} from '../src/storage.ts';

export async function privateStorageFromEnvironment(){
 const raw=process.env.TEST_STORAGE_API_URL,secret=process.env.TEST_STORAGE_SERVICE_KEY;
 if(!raw&&!secret)return null;
 assert(raw&&secret,'Both local Storage configuration fields are required');
 const target=new URL(raw);
 assert(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)
  &&target.pathname==='/'&&!target.username&&!target.password&&!target.search&&!target.hash,'Disposable loopback Storage required');
 const server=createServer((incoming,outgoing)=>{
  if(!incoming.url?.startsWith('/storage/v1/')){outgoing.writeHead(404);outgoing.end();return;}
  const upstream=httpRequest(new URL(incoming.url.slice('/storage/v1'.length),target),{
   method:incoming.method,headers:{...incoming.headers,host:target.host}},response=>{
    outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);
   });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
  incoming.on('aborted',()=>upstream.destroy());incoming.pipe(upstream);
 });
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
 const origin='http://127.0.0.1:'+server.address().port;
 const suffix=crypto.randomUUID().replaceAll('-',''),names={
  PHOTOS:'lovelies-photos-'+suffix,QUARANTINE:'lovelies-quarantine-'+suffix,PRIVACY_EXPORTS:'lovelies-privacy-exports-'+suffix};
 try{
  const headers={authorization:'Bearer '+secret,apikey:secret,'content-type':'application/json'};
  for(const name of Object.values(names)){
   const created=await fetch(origin+'/storage/v1/bucket',{method:'POST',headers,
    body:JSON.stringify({id:name,name,public:false,file_size_limit:20*1024*1024})});
   assert.equal(created.status,200,'Local Supabase Storage bucket creation failed');await created.body?.cancel();
   const readback=await fetch(origin+'/storage/v1/bucket/'+name,{headers});
   assert.equal(readback.status,200,'Local Supabase Storage private bucket readback failed');
   assert.equal((await readback.json()).public,false);
  }
  return {origin,names,buckets:Object.fromEntries(Object.entries(names).map(([field,name])=>[field,new SupabasePrivateBucket(origin,secret,name)])),
   close:()=>new Promise(done=>{server.close(done);server.closeIdleConnections();})};
 }catch(error){await new Promise(done=>server.close(done));throw error;}
}
