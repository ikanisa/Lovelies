/** Executed inside the private network. Input and raw provider bodies are secret. */
import {createHash,randomUUID} from 'node:crypto';
const input=[];for await(const chunk of process.stdin)input.push(chunk);
const config=JSON.parse(Buffer.concat(input).toString());
if(config.origin!=='http://api-gw:8000'||config.execute!==true)throw Error('qualification_context_invalid');
const nonce=randomUUID(),bucket='qualification-'+nonce,key='known-bytes.bin',checks=[];
const bytes=Buffer.from('Lovelies private Storage qualification '+nonce+'\n');
const digest=value=>createHash('sha256').update(value).digest('hex');
const admin={apikey:config.serviceKey,authorization:'Bearer '+config.serviceKey};
const anon={apikey:config.anonKey};let userID=null,bucketCreated=false,objectCreated=false;
const request=(route,{method='GET',headers={},body}={})=>fetch(config.origin+route,{method,headers,...body===undefined?{}:{body},redirect:'error',signal:AbortSignal.timeout(20000)});
const jsonRequest=(route,method,headers,body)=>request(route,{method,headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
const check=async(id,run)=>{try{const evidence=await run();checks.push({id,status:'passed',...evidence});}catch{checks.push({id,status:'failed'});}};
let accessToken=null,refreshToken=null;
try{
 await check('managed_auth_anonymous_signup',async()=>{
  const response=await jsonRequest('/auth/v1/signup','POST',anon,{data:{qualification_run:nonce}});if(!response.ok)throw Error();
  const value=await response.json();userID=value.user?.id;accessToken=value.access_token;refreshToken=value.refresh_token;
  if(!userID||!accessToken||!refreshToken||value.user.is_anonymous!==true)throw Error();
  return {anonymous:true};
 });
 await check('managed_auth_rotation',async()=>{
  if(!refreshToken)throw Error();const response=await jsonRequest('/auth/v1/token?grant_type=refresh_token','POST',anon,{refresh_token:refreshToken});
  if(!response.ok)throw Error();const value=await response.json();if(value.user?.id!==userID||!value.refresh_token||!value.access_token)throw Error();
  accessToken=value.access_token;refreshToken=value.refresh_token;return {same_managed_user:true};
 });
 await check('private_storage_known_bytes',async()=>{
  let response=await jsonRequest('/storage/v1/bucket','POST',admin,{id:bucket,name:bucket,public:false,file_size_limit:1048576});
  if(!response.ok)throw Error();bucketCreated=true;
  response=await request('/storage/v1/object/'+bucket+'/'+key,{method:'POST',headers:{...admin,'content-type':'application/octet-stream','x-upsert':'false'},body:bytes});
  if(!response.ok)throw Error();objectCreated=true;
  response=await request('/storage/v1/object/'+bucket+'/'+key,{headers:admin});if(!response.ok)throw Error();
  const downloaded=Buffer.from(await response.arrayBuffer());if(!downloaded.equals(bytes))throw Error();
  return {byte_count:bytes.length,sha256:digest(bytes)};
 });
 for(const [id,headers,route] of [
  ['storage_no_api_key_denied',{},'/storage/v1/object/'+bucket+'/'+key],
  ['storage_anon_key_denied',anon,'/storage/v1/object/'+bucket+'/'+key],
  ['storage_unrelated_managed_user_denied',{...anon,authorization:'Bearer '+accessToken},'/storage/v1/object/'+bucket+'/'+key],
  ['storage_public_route_denied',anon,'/storage/v1/object/public/'+bucket+'/'+key],
 ])await check(id,async()=>{if(!objectCreated||id.includes('managed')&&!accessToken)throw Error();const response=await request(route,{headers});await response.body?.cancel();if(![400,401,403,404].includes(response.status))throw Error();return {http_status:response.status};});
 await check('private_schema_not_exposed',async()=>{
  const response=await request('/rest/v1/accounts?select=id&limit=1',{headers:{...anon,'accept-profile':'lovelies_private'}});await response.body?.cancel();
  if(![400,401,403,404,406].includes(response.status))throw Error();return {http_status:response.status};
 });
 await check('managed_auth_logout_revokes_refresh',async()=>{
  if(!accessToken||!refreshToken)throw Error();let response=await request('/auth/v1/logout?scope=global',{method:'POST',headers:{...anon,authorization:'Bearer '+accessToken}});
  if(!response.ok)throw Error();await response.body?.cancel();
  response=await jsonRequest('/auth/v1/token?grant_type=refresh_token','POST',anon,{refresh_token:refreshToken});await response.body?.cancel();
  if(![400,401,403].includes(response.status))throw Error();return {http_status:response.status};
 });
}finally{
 await check('synthetic_resources_removed',async()=>{
  let clean=true;
  if(objectCreated){const response=await jsonRequest('/storage/v1/object/'+bucket,'DELETE',admin,{prefixes:[key]});clean=clean&&response.ok;await response.body?.cancel();}
  if(bucketCreated){const response=await request('/storage/v1/bucket/'+bucket,{method:'DELETE',headers:admin});clean=clean&&response.ok;await response.body?.cancel();}
  if(userID){const response=await request('/auth/v1/admin/users/'+userID,{method:'DELETE',headers:admin});clean=clean&&response.ok;await response.body?.cancel();}
  if(!clean)throw Error();return {only_this_run_resources:true};
 });
}
process.stdout.write(JSON.stringify({protocol:'lovelies-private-host-probes-v1',run_id:nonce,checks}));
