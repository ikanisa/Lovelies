import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {MemoryStorage,env,request} from '../../restore-journal/test/fixtures.mjs';
import {handleOperationRequest} from '../../restore-journal/src/operations.mjs';
import {RestoreJournalClient} from '../src/restore-journal.ts';
import {RestoreExternalEffects} from '../src/restore-effects.ts';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {AuthenticatedService} from '../src/service-fetcher.ts';
async function fixture(){
 const storage=new MemoryStorage();let tick=1000,loseObserve=false;
 const call=async(path,body)=>{const r=await handleOperationRequest(request(path,body),env,storage,{now:()=>++tick});return {status:r.status,body:await r.json()};};
 const bootstrap=await call('/v1/control/bootstrap',{version:1,project_id:env.SUPABASE_PROJECT_ID,database_id:randomUUID(),bootstrap_id:randomUUID()});assert.equal(bootstrap.status,200);
 const marker=bootstrap.body.control.marker;let lineage={database_id:marker.database_id,incarnation_id:marker.incarnation_id};
 const journal=new RestoreJournalClient('https://journal.invalid',env.RESTORE_JOURNAL_TOKEN,{fetcher:async(url,init)=>{
  const r=await handleOperationRequest(new Request(url,init),env,storage,{now:()=>++tick});
  if(loseObserve&&new URL(url).pathname.endsWith('/observe')){loseObserve=false;await r.body.cancel();throw Error('synthetic_observation_reply_lost');}return r;
 }});
 return {storage,journal,marker,call,effects:new RestoreExternalEffects(journal,()=>lineage,async()=>bootstrap.body.control.marker.database_id),retire:()=>lineage={...lineage,incarnation_id:randomUUID()},lose:()=>loseObserve=true};
}
function fakeStorage(){
 const objects=new Map();let puts=0,release,hold=false;const started=Promise.withResolvers();
 const fetcher=async(url,init={})=>{
  const r=new Request(url,init),p=new URL(r.url).pathname;
  if(r.method==='POST'&&p.includes('/object/list/'))return Response.json([]);
  const key=p.split('/lovelies-photos/')[1];
  if(r.method==='POST'){puts++;const bytes=new Uint8Array(await r.arrayBuffer()),metadata=JSON.parse(atob(r.headers.get('x-metadata')));objects.set(key,{bytes,metadata,etag:'synthetic-'+puts});started.resolve();
   if(hold)await new Promise(resolve=>release=resolve);return new Response(null,{status:200});}
  const item=objects.get(key);
  if(!item)return Response.json({statusCode:'404',error:'not_found',code:'NoSuchKey',message:'Object not found'},{status:400});
  if(p.includes('/object/info/'))return Response.json({size:item.bytes.length,etag:item.etag,user_metadata:item.metadata});
  return new Response(item.bytes,{headers:{etag:item.etag}});
 };
 return {objects,fetcher,get puts(){return puts;},hold:()=>hold=true,started:started.promise,release:()=>release()};
}
test('production private Storage adapter journals before PUT and recovers lost observation without re-upload',async()=>{
 const f=await fixture(),remote=fakeStorage(),bucket=new SupabasePrivateBucket('https://storage.invalid','synthetic-secret','lovelies-photos',remote.fetcher,f.effects.storage('PHOTOS'));
 f.lose();await assert.rejects(bucket.put('owner/asset/version/object',new Uint8Array([1,2,3]),{customMetadata:{source_version:'version'}}));assert.equal(remote.puts,1);
 await bucket.put('owner/asset/version/object',new Uint8Array([1,2,3]),{customMetadata:{source_version:'version'}});assert.equal(remote.puts,1,'receipt loss must not cause another PUT');
 const page=await f.call('/v1/effects/page',{version:1,project_id:env.SUPABASE_PROJECT_ID,after:0,limit:32});assert.equal(page.body.effects.length,1);assert.equal(page.body.effects[0].status,'succeeded');
});
test('late immutable Storage reply adds evidence during quarantine without admitting another writer',async()=>{
 const f=await fixture(),remote=fakeStorage();remote.hold();const bucket=new SupabasePrivateBucket('https://storage.invalid','synthetic-secret','lovelies-photos',remote.fetcher,f.effects.storage('PHOTOS'));
 const pending=bucket.put('owner/asset/version/object',new Uint8Array([1,2,3]));await remote.started;
 const begun=await f.call('/v1/recovery/begin-v2',{version:2,project_id:env.SUPABASE_PROJECT_ID,recovery_id:randomUUID(),expected:f.marker});assert.equal(begun.status,200);
 remote.release();await pending;assert.equal((await f.journal.control()).state,'quarantined');
 await assert.rejects(bucket.put('owner/asset/version/another',new Uint8Array([1,2,3])));assert.equal(remote.puts,1);
 const page=await f.call('/v1/effects/page',{version:1,project_id:env.SUPABASE_PROJECT_ID,after:0,limit:32});assert.equal(page.body.effects[0].status,'succeeded');
});
test('stale SQL invocation cannot dispatch a private provider request; each admitted request has an independent payload hash',async()=>{
 const f=await fixture();let calls=0;const service=new AuthenticatedService('https://provider.invalid','synthetic-private-service-token-32',async()=>{calls++;return Response.json({accepted:true});},1000,undefined,f.effects.service('push'));
 const payload=JSON.stringify({operation_key:randomUUID(),kind:'synthetic'});let response=await service.fetch('https://internal.invalid/send',{method:'POST',body:payload});await response.json();assert.equal(calls,1);
 const page=await f.call('/v1/effects/page',{version:1,project_id:env.SUPABASE_PROJECT_ID,after:0,limit:32});assert.equal(page.body.effects[0].descriptor.target.service,'push');assert.equal(page.body.effects[0].descriptor.byte_size,new TextEncoder().encode(payload).length);
 f.retire();await assert.rejects(service.fetch('https://internal.invalid/send',{method:'POST',body:payload}));assert.equal(calls,1);
});
test('recovery namespace listing bounds body and validates folders, duplicate names, and path traversal',async()=>{
 const make=(items)=>new SupabasePrivateBucket('https://storage.invalid','synthetic-secret','lovelies-photos',async()=>Response.json(items));
 assert.deepEqual(await make([{name:'folder',id:null},{name:'file.bin',id:randomUUID()}]).list('',0,32),[{name:'folder',folder:true},{name:'file.bin',folder:false}]);
 await assert.rejects(make([{name:'../escape',id:randomUUID()}]).list('',0,32));
 await assert.rejects(make([{name:'a',id:null},{name:'a',id:null}]).list('',0,32));
 await assert.rejects(make([{name:'x'.repeat(300000),id:null}]).list('',0,32));
});
