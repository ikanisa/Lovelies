import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SupabaseManagedAuth} from '../src/managed-auth-provider.ts';
const marker='a'.repeat(64),anon='fixture-anonymous-key',service='fixture.service.key';
const jwt=claims=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture';
const session=()=>{const user={id:crypto.randomUUID(),is_anonymous:true};return {user,access_token:jwt({sub:user.id,session_id:crypto.randomUUID(),
 role:'authenticated',aud:'authenticated',is_anonymous:true,exp:Math.floor(Date.now()/1000)+3600}),refresh_token:'a1b2c3d4e5f6',token_type:'bearer'};};
const adapter=fetcher=>new SupabaseManagedAuth('http://api-gw:8000',anon,service,fetcher,{trustedHttpOrigins:['http://api-gw:8000']},100);
test('supported signup/refresh verify user identity and retain the provider opaque 12-character refresh token',async()=>{
 const value=session(),calls=[];
 const api=adapter(async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/user')?value.user:value);});
 const first=await api.signUp(marker),next=await api.refresh(first.refresh_token);
 assert.equal(first.user_id,value.user.id);assert.equal(next.refresh_token,'a1b2c3d4e5f6');
 assert.deepEqual(JSON.parse(calls[0].init.body),{data:{lovelies_creation_marker:marker}});
 assert.equal(calls[0].init.headers.get('apikey'),anon);assert.equal(calls[1].init.headers.get('authorization'),'Bearer '+value.access_token);
 assert.equal(calls[2].url,'http://api-gw:8000/auth/v1/token?grant_type=refresh_token');
 assert(calls.every(call=>call.init.redirect==='manual'));
});
test('unverified identities, redirects, malformed and time-out replies never create a usable managed session',async t=>{
 const value=session();
 await t.test('user verification mismatch',async()=>{
  const api=adapter(async url=>Response.json(url.endsWith('/user')?{...value.user,id:crypto.randomUUID()}:value));
  await assert.rejects(()=>api.signUp(marker),{code:'managed_auth_reply_unbound'});
 });
 await t.test('wrong anonymous claim',async()=>{
  const api=adapter(async()=>Response.json({...value,user:{...value.user,is_anonymous:false}}));
  await assert.rejects(()=>api.signUp(marker),{code:'managed_auth_reply_unbound'});
 });
 await t.test('redirect',async()=>{await assert.rejects(()=>adapter(async()=>new Response(null,{status:307,headers:{location:'https://outside.test'}})).signUp(marker),{code:'managed_auth_redirect_denied'});});
 await t.test('bounded timeout',async()=>{await assert.rejects(()=>adapter(async()=>new Promise(()=>{})).signUp(marker),{code:'managed_auth_transport_unresolved'});});
 await t.test('unqualified not-found is not deletion evidence',async()=>{await assert.rejects(()=>adapter(async()=>Response.json({error:'not found'},{status:404})).userExists(crypto.randomUUID()),{code:'managed_auth_user_unverified'});});
});
test('orphan discovery requires exact anonymous marker/time and independently re-fetches the candidate',async()=>{
 const now=Date.now(),user={id:crypto.randomUUID(),is_anonymous:true,created_at:new Date(now).toISOString(),user_metadata:{lovelies_creation_marker:marker}};
 const calls=[],api=adapter(async(url,init)=>{calls.push({url,init});return Response.json(url.includes('?page=')?{users:[user]}:user);});
 assert.deepEqual(await api.signupCandidates(marker,now,1),{userIds:[user.id],nextPage:1});
 assert.equal(calls.length,2);assert(calls.every(call=>call.init.headers.get('authorization')==='Bearer '+service));
 const changed=adapter(async url=>Response.json(url.includes('?page=')?{users:[user]}:{...user,user_metadata:{}}));
 await assert.rejects(()=>changed.signupCandidates(marker,now,1),{code:'managed_auth_lookup_unresolved'});
 const unrelated=adapter(async()=>Response.json({users:[{...user,is_anonymous:false},{...user,created_at:new Date(now+120000).toISOString()}]}));
 assert.deepEqual(await unrelated.signupCandidates(marker,now,1),{userIds:[],nextPage:1});
 const duplicate=adapter(async url=>Response.json(url.includes('?page=')?{users:[user,user]}:user));
 await assert.rejects(()=>duplicate.signupCandidates(marker,now,1),{code:'managed_auth_lookup_ambiguous'});
});
test('readiness requires anonymous signup enabled and deletion uses public admin HTTP APIs',async()=>{
 const id=crypto.randomUUID(),calls=[];
 const api=adapter(async(url,init)=>{calls.push({url,init});return url.endsWith('/settings')?Response.json({external:{anonymous_users:true},disable_signup:false}):
  init.method==='DELETE'?new Response(null,{status:204}):Response.json({code:'user_not_found'},{status:404});});
 assert.equal(await api.ready(),true);await api.deleteUser(id);assert.equal(await api.userExists(id),false);
 assert.equal(calls[1].init.method,'DELETE');assert.deepEqual(JSON.parse(calls[1].init.body),{should_soft_delete:false});
 assert.equal(await adapter(async()=>Response.json({external:{anonymous_users:true},disable_signup:true})).ready(),false);
});
