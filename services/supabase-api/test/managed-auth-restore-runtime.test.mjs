import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture,seedAccount,privateRows,databaseConnection} from './restore-database-fixture.mjs';
import {RestoreRecoveryController} from '../src/restore-recovery.ts';
import {ApiError,stable,digest} from '../src/types.ts';
import {rosterFixture} from '../../push-provider/test/roster-fixture.mjs';
import {env as ledgerEnv} from '../../push-provider/test/independent-ledger-fixture.mjs';

const emptyBucket=()=>({head:async()=>null,get:async()=>null,list:async()=>[],delete:async()=>{},put:async()=>{throw Error('unexpected_recovery_write');}});
async function recovery(t,f,services={}){
 const boundary={open:false},faults={beforeBegin:async()=>{boundary.open=true;},afterCommit:async()=>{boundary.open=false;}};
 const connection=databaseConnection(f.h,[],faults);t.after(()=>connection.close());
 const controller=new RestoreRecoveryController(connection,f.journal,{PHOTOS:emptyBucket(),QUARANTINE:emptyBucket(),PRIVACY_EXPORTS:emptyBucket()},Date.now,services);
 return {controller,boundary};
}
async function finish(controller,id){for(let n=0;n<100;n++){const value=await controller.step(id);if(value.phase==='completed')return value;}throw Error('synthetic_recovery_step_limit');}
async function erasedEpisode(f,subject,reviewer,request){
 await f.db.transaction(async scope=>{scope.operation({operation_id:randomUUID(),input_hash:'d'.repeat(64),allocations:{}});
  await scope.restrict('account-deletion-requested',{account_id:subject,deletion_request_id:request});
  await scope.restrict('account-deletion-reviewed',{account_id:subject,deletion_request_id:request,reviewer_id:reviewer,decision:'approved'});
  await scope.restrict('account-erased',{account_id:subject,deletion_request_id:request});
 });
}
async function pushRecovery(t,boundary,onReply=async()=>{}){
 const provider=await rosterFixture();t.after(()=>provider.storage.database.close());const calls=[];
 return {calls,services:{PUSH_PROVIDER_GENERATION:provider.generation,PUSH_LEDGER_ID:ledgerEnv.PUSH_LEDGER_ID,PUSH_LEDGER_BOOTSTRAP_ID:provider.bootstrap,
  PUSH_SERVICE:{fetch:async(url,init)=>{assert.equal(boundary.open,false,'push retirement must be outside SQL');
   const path=new URL(url).pathname;assert.match(path,/^\/subjects\/[0-9a-f]{64}\/retire$/);assert.equal(init.method,'POST');calls.push(path);
   const response=await provider.call(path,JSON.parse(init.body));await onReply();return response;}}}};
}

test('restore retires managed Auth through provider APIs outside SQL and clears custody only after verified absence',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),user=randomUUID(),session=randomUUID(),binding=randomUUID(),marker=(await f.journal.control()).marker;
 // Test-only auth schema seeds exercise the real restricted SQL predicate.
 // Production creation/deletion is exclusively through the public Auth API.
 await f.h.engine.exec('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz,created_at timestamptz);');
 await f.h.engine.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,true)',[user]);
 await f.h.engine.query('INSERT INTO auth.sessions(id,user_id,created_at) VALUES($1,$2,$3)',[session,user,new Date()]);
 const raw=crypto.getRandomValues(new Uint8Array(32)),encryption=Buffer.from(raw).toString('base64url'),iv=crypto.getRandomValues(new Uint8Array(12)),expires=Date.now()+3600000;
 const tokens={access_token:'synthetic-provider-access',refresh_token:'synthetic-provider-refresh',user_id:user,session_id:session,expires_at:expires};
 const aad=stable({protocol:'lovelies-managed-auth-custody-v1',id:binding,account_id:subject,incarnation_id:marker.incarnation_id,auth_user_id:user,auth_session_id:session});
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(aad)},await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']),new TextEncoder().encode(JSON.stringify(tokens)));
 await f.db.run("INSERT INTO lovelies_private.managed_auth_bindings(id,account_id,incarnation_id,operation,state,creation_marker,auth_user_id,auth_session_id,ciphertext,iv,tokens_expires_at,created_at,updated_at,retire_after) VALUES(?,?,?,'signup','prepared',?,?,?,?,?,?,1000,1000,9000000000000)",binding,subject,marker.incarnation_id,'a'.repeat(64),user,session,Buffer.from(cipher).toString('base64url'),Buffer.from(iv).toString('base64url'),expires);
 const trace=[],services={MANAGED_AUTH_ENCRYPTION_KEY:encryption,AUTH_SIGNING_SECRET:'separate-app-signing',MEDIA_SIGNING_SECRET:'separate-media-signing'};
 const {controller,boundary}=await recovery(t,f,services);let unavailable=true;
 services.MANAGED_AUTH={
  signOut:async access=>{assert.equal(boundary.open,false);assert.equal(access,tokens.access_token);trace.push('logout');await f.h.engine.query('DELETE FROM auth.sessions WHERE id=$1',[session]);},
  deleteUser:async id=>{assert.equal(boundary.open,false);assert.equal(id,user);trace.push('delete');if(unavailable)throw new ApiError(503,'managed_auth_delete_unresolved');await f.h.engine.query('DELETE FROM auth.users WHERE id=$1',[id]);},
  userExists:async id=>{assert.equal(boundary.open,false);trace.push('absence');return (await f.h.engine.query('SELECT id FROM auth.users WHERE id=$1',[id])).rows.length>0;}
 };
 const id=randomUUID();await controller.begin(id);assert.equal((await controller.step(id)).phase,'managed-auth-retirement');
 assert.equal((await f.journal.control()).state,'quarantined');let row=(await privateRows(f.h,'SELECT * FROM lovelies_private.managed_auth_bindings WHERE id=$1',[binding]))[0];
 assert.equal(row.state,'retiring');assert.notEqual(row.ciphertext,null);assert.equal(row.user_deleted_at,null);
 unavailable=false;await finish(controller,id);row=(await privateRows(f.h,'SELECT * FROM lovelies_private.managed_auth_bindings WHERE id=$1',[binding]))[0];
 assert.equal(row.state,'retired');assert.equal(row.ciphertext,null);assert.equal(row.iv,null);assert.ok(row.user_deleted_at>0);
 assert(trace.includes('logout'));assert(trace.includes('absence'));assert.equal(Number((await f.h.engine.query('SELECT count(*) n FROM auth.users')).rows[0].n),0);
 assert.equal((await privateRows(f.h,'SELECT name FROM lovelies_private.accounts WHERE id=$1',[subject]))[0].name,'Preserved synthetic account','authority retirement does not erase the canonical face account');
});

test('unresolved managed signup never proves absence or allows restore clearance',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),id=randomUUID(),binding=randomUUID(),marker=(await f.journal.control()).marker;
 await f.db.run("INSERT INTO lovelies_private.managed_auth_bindings(id,account_id,incarnation_id,operation,state,creation_marker,created_at,updated_at,retire_after) VALUES(?,?,?,'signup','ambiguous',?,1000,1000,1000)",binding,subject,marker.incarnation_id,'b'.repeat(64));
 const services={MANAGED_AUTH_ENCRYPTION_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')},r=await recovery(t,f,services);let looked=0;
 services.MANAGED_AUTH={signupCandidates:async()=>{assert.equal(r.boundary.open,false);looked++;return {userIds:[],nextPage:1};},deleteUser:async()=>assert.fail('no identity is proven')};
 await r.controller.begin(id);for(let n=0;n<2;n++)assert.equal((await r.controller.step(id)).phase,'managed-auth-retirement');
 assert.equal(looked,2);assert.equal((await f.journal.control()).state,'quarantined');
 const row=(await privateRows(f.h,'SELECT state,auth_user_id,user_deleted_at FROM lovelies_private.managed_auth_bindings WHERE id=$1',[binding]))[0];assert.deepEqual(row,{state:'ambiguous',auth_user_id:null,user_deleted_at:null});
});

test('restore push retirement releases SQL and a hold introduced during the reply blocks metadata erasure',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),reviewer=await seedAccount(f.h),request=randomUUID(),services={};
 await erasedEpisode(f,subject,reviewer,request);const r=await recovery(t,f,services);
 const push=await pushRecovery(t,r.boundary,()=>privateRows(f.h,'UPDATE lovelies_private.privacy_requests SET legal_hold=1 WHERE id=$1',[request]));Object.assign(services,push.services);
 const id=randomUUID();await r.controller.begin(id);await assert.rejects(()=>finish(r.controller,id),error=>error?.code==='privacy_legal_hold');
 assert.equal(push.calls.length,1);assert.equal((await f.journal.control()).state,'quarantined');
 assert.equal((await privateRows(f.h,'SELECT metadata_erased_at FROM lovelies_private.privacy_requests WHERE id=$1',[request]))[0].metadata_erased_at,null);
 assert.equal((await privateRows(f.h,'SELECT name FROM lovelies_private.accounts WHERE id=$1',[subject]))[0].name,'Preserved synthetic account');
});

test('exact independent push retirement authorizes only the bound erased subject and completes metadata cleanup',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),reviewer=await seedAccount(f.h),request=randomUUID(),services={};
 await erasedEpisode(f,subject,reviewer,request);const r=await recovery(t,f,services),push=await pushRecovery(t,r.boundary);Object.assign(services,push.services);
 const id=randomUUID();await r.controller.begin(id);assert.equal((await finish(r.controller,id)).phase,'completed');
 assert.deepEqual(push.calls,['/subjects/'+await digest('lovelies-push-subject-v2:'+subject)+'/retire']);
 const row=(await privateRows(f.h,'SELECT metadata_erased_at,status FROM lovelies_private.privacy_requests WHERE id=$1',[request]))[0];assert.ok(row.metadata_erased_at>0);assert.equal(row.status,'completed');
 assert.notEqual((await privateRows(f.h,'SELECT name FROM lovelies_private.accounts WHERE id=$1',[subject]))[0].name,'Preserved synthetic account');
 assert.equal((await privateRows(f.h,'SELECT name FROM lovelies_private.accounts WHERE id=$1',[reviewer]))[0].name,'Preserved synthetic account');
});
