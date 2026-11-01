import {createServer} from 'node:http';
import {once} from 'node:events';

/** Test-only HTTP GoTrue double for the actual Deno entrypoint/PG lane.
 * Production never writes auth tables; only this isolated fixture seeds them.
 * Real GoTrue issuance, rate limits and crypto remain a separate host gate. */
export async function startManagedAuthHTTPFixture(engine){
 await engine.exec(`CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean NOT NULL,deleted_at timestamptz,banned_until timestamptz,created_at timestamptz NOT NULL,raw_user_meta_data jsonb);
  CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz,created_at timestamptz NOT NULL);`);
 const access=new Map(),refresh=new Map();
 const issue=(user,session)=>{const exp=Math.floor(Date.now()/1000)+3600;
  const token=Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:user.id,session_id:session,role:'authenticated',aud:'authenticated',is_anonymous:true,exp})).toString('base64url')+'.synthetic';
  const result={access_token:token,refresh_token:crypto.randomUUID(),token_type:'bearer',expires_at:exp,user};
  access.set(token,{user,session});refresh.set(result.refresh_token,{user,session});return result;};
 const server=createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url,'http://localhost'),parts=[];let count=0;
   for await(const part of req){count+=part.length;if(count>32768){reply(413,{});return;}parts.push(part);}
   const body=parts.length?JSON.parse(Buffer.concat(parts).toString()):{},bearer=String(req.headers.authorization??'').replace(/^Bearer /,'');
   if(url.pathname==='/auth/v1/settings'){reply(200,{external:{anonymous_users:true},disable_signup:false});return;}
   if(url.pathname==='/auth/v1/signup'&&req.method==='POST'){
    const user={id:crypto.randomUUID(),is_anonymous:true,created_at:new Date().toISOString(),user_metadata:body.data},session=crypto.randomUUID();
    await engine.query('INSERT INTO auth.users(id,is_anonymous,created_at,raw_user_meta_data) VALUES($1,true,$2,$3::text::jsonb)',[user.id,user.created_at,JSON.stringify(body.data)]);
    await engine.query('INSERT INTO auth.sessions(id,user_id,created_at) VALUES($1,$2,$3)',[session,user.id,user.created_at]);reply(200,issue(user,session));return;
   }
   if(url.pathname==='/auth/v1/token'&&req.method==='POST'){
    const prior=refresh.get(body.refresh_token);if(!prior){reply(400,{code:'refresh_token_not_found'});return;}
    refresh.delete(body.refresh_token);reply(200,issue(prior.user,prior.session));return;
   }
   if(url.pathname==='/auth/v1/user'){
    const prior=access.get(bearer);reply(prior?200:401,prior?.user??{code:'bad_jwt'});return;
   }
   if(url.pathname==='/auth/v1/logout'){
    const prior=access.get(bearer);if(prior)await engine.query('DELETE FROM auth.sessions WHERE id=$1',[prior.session]);res.writeHead(204);res.end();return;
   }
   const userPath=/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(url.pathname);
   if(userPath){
    if(req.method==='DELETE'){await engine.query('DELETE FROM auth.users WHERE id=$1',[userPath[1]]);res.writeHead(204);res.end();return;}
    const found=(await engine.query('SELECT id,is_anonymous,created_at,raw_user_meta_data AS user_metadata FROM auth.users WHERE id=$1',[userPath[1]])).rows[0];
    reply(found?200:404,found??{code:'user_not_found'});return;
   }
   if(url.pathname==='/auth/v1/admin/users'){
    const page=Number(url.searchParams.get('page')??1),size=Number(url.searchParams.get('per_page')??50);
    reply(200,{users:(await engine.query('SELECT id,is_anonymous,created_at,raw_user_meta_data AS user_metadata FROM auth.users ORDER BY created_at,id LIMIT $1 OFFSET $2',[size,(page-1)*size])).rows});return;
   }
   reply(404,{code:'fixture_route_unavailable'});
  }catch{reply(500,{code:'fixture_failure'});}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:'http://127.0.0.1:'+server.address().port,port:server.address().port,
  close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
