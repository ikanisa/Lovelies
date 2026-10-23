import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {OperatorSession,OperatorVault,apiBase,operationBody} from './operator-session.mjs';
import {IDBFactory} from 'fake-indexeddb';
import {faceSigningBytes,toBase64url} from '../clients/backend/face-contracts.mjs';
import {startHarness,closeHarnesses,faceVerifierFixture} from '../services/supabase-api/test/runtime-harness.mjs';
after(closeHarnesses);
class Vault {
 async load(){return this.value?structuredClone(this.value):null;}
 async create(){this.pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',this.pair.publicKey);this.value={version:1,base:'http://localhost/functions/v1/lovelies-api',devicePublicJwk:jwk,reference:null,enrollment:null,anonymous:null,pendingAction:null};return structuredClone(this.value);}
 async save(value){this.value=structuredClone(value);}
 async sign(value){return toBase64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},this.pair.privateKey,faceSigningBytes(value))));}
}
async function fixture(){const h=await startHarness({faceVerifier:faceVerifierFixture});const vault=new Vault();
 const session=new OperatorSession({baseUrl:'http://localhost/functions/v1/lovelies-api',policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,
  fetch:(url,init)=>h.request(url,{method:init.method,raw:init.body,headers:init.headers})});return {h,vault,session};}
const captures=async session=>{for(let i=0;i<3;i++)await session.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3,i]));};
test('operator URL confinement and guarded review body reject malformed inputs',async()=>{
 for(const base of ['https://example.com/prefix','https://u:p@example.com','http://example.com','https://example.com/?token=1'])assert.throws(()=>apiBase(base));
 let calls=0;const s=new OperatorSession({baseUrl:'https://example.com/functions/v1/lovelies-api',fetch:()=>{calls++;throw Error();}});
 for(const path of ['/../secret','/%2e%2e/secret','/auth/../secret','//evil.com','/health#fragment','/a%2fb'])await assert.rejects(s.request(path),{code:'invalid_api_path'});
 assert.equal(calls,0);assert.throws(()=>operationBody('disable',{id:'invalid',revision:1},'reason',crypto.randomUUID()),{code:'invalid_review'});
});
test('three signed captures enroll same account; admin role is never self-granted',async()=>{
 const {h,session}=await fixture();await session.startEnrollment(true);const account=session.state.anonymous.account_id;await captures(session);
 await assert.rejects(session.complete(),{code:'operator_provisioning_required'});assert.equal(session.credentials,null);assert.equal(session.operator,null);
 assert.equal(session.state.reference.accountId,account);const row=await h.db.one('SELECT roles_json FROM accounts WHERE id=?',account);assert.deepEqual(JSON.parse(row.roles_json),['user']);await h.close();
});
test('lost capture reply recovers durable manifest and registered authority without bootstrap',async()=>{
 const {h,vault,session}=await fixture();await session.startEnrollment(true);await session.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,7]));
 const restored=new OperatorSession({baseUrl:session.base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,fetch:session.fetch});
 assert.deepEqual(await restored.restore(),{registered:false,pending:true});await restored.recoverEnrollment();assert.equal(restored.captures.length,1);
 for(let i=1;i<3;i++)await restored.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,7+i]));
 // Test-only controlled provisioning; there is no client role-grant endpoint.
 await assert.rejects(restored.complete(),{code:'operator_provisioning_required'});
 const id=restored.state.reference.accountId;
 await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),id);
 await restored.logout();assert.equal(restored.operator,null);await restored.startLogin();await restored.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,11]));await restored.complete();assert.equal(restored.operator.user_id,id);await h.close();
});
test('logout during device signing prevents subsequent capture dispatch',async()=>{
 const {h,vault,session}=await fixture();await session.startEnrollment(true);let release,entered;
 const waiting=new Promise(resolve=>entered=resolve);const sign=vault.sign.bind(vault);vault.sign=async value=>{entered();await new Promise(resolve=>release=resolve);return sign(value);};
 const upload=session.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,9]));await waiting;await session.logout();release();await assert.rejects(upload,{code:'session_changed'});
 assert.equal((await h.db.one('SELECT count(*) n FROM auth_capture_proofs')).n,0);await h.close();
});
test('uncertain operator action retains original key and blocks a conflicting retry',async()=>{
 const vault=new Vault();await vault.create();const s=new OperatorSession({baseUrl:vault.value.base,policyVersion:'x',vault,fetch:async()=>{throw new Error('reply_lost');}});
 s.state=await vault.load();s.operator={user_id:crypto.randomUUID()};s.credentials={access_token:'fixture'};
 const body={operation_key:crypto.randomUUID(),reason:'Review the request'};await assert.rejects(s.action('/admin/privacy-requests/'+crypto.randomUUID()+'/review',body),/reply_lost/);
 assert.equal(vault.value.pendingAction.body.operation_key,body.operation_key);await assert.rejects(s.action('/admin/other',{operation_key:crypto.randomUUID()}),{code:'reconcile_previous_action'});
});
test('lost committed enrollment renewal replays its saved key and original successor session',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),base='http://localhost';
 const idb=new IDBFactory();let loseReply=true,refreshes=0;
 const fetch=async(url,init)=>{const path=new URL(url).pathname;
   if(path==='/auth/session/refresh')refreshes++;
   const reply=await h.request(path,{method:init.method,raw:init.body,headers:init.headers});
   if(path==='/auth/face/registration/resume'&&reply.ok&&loseReply){loseReply=false;await reply.body.cancel();throw new Error('lost_committed_resume_reply');}return reply;
 };
 const original=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});
 await original.startEnrollment(true);const predecessor=original.challenge.challenge_id;
 await h.db.run('UPDATE auth_challenges SET created_at=?,expires_at=? WHERE id=?',Date.now()-130000,Date.now()-1000,predecessor);
 await assert.rejects(original.restartEnrollment(),/lost_committed_resume_reply/);
 const intent=await h.db.one('SELECT * FROM face_enrollment_intents WHERE account_id=?',original.state.anonymous.account_id);assert.equal(intent.generation,2);
 const restored=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});
 await restored.restore();await restored.restartEnrollment();assert.equal(refreshes,1);assert.equal(restored.challenge.challenge_id,intent.challenge_id);
 const bound=await h.db.one('SELECT s.revoked_at FROM auth_challenges c JOIN sessions s ON s.id=c.session_id WHERE c.id=?',intent.challenge_id);assert.equal(bound.revoked_at,null);
 await restored.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,90]));assert.equal(restored.captures.length,1);await h.close();
});
test('lost committed refresh reply survives encrypted vault reload without a second rotation',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),base='http://localhost',idb=new IDBFactory();let lose=true,refreshPosts=0;
 const fetch=async(url,init)=>{const path=new URL(url).pathname;const reply=await h.request(path,{method:init.method,raw:init.body,headers:init.headers});
   if(path==='/auth/session/refresh'){refreshPosts++;if(lose&&reply.ok){lose=false;await reply.body.cancel();throw new Error('lost_committed_refresh_reply');}}return reply;};
 const original=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});
 await original.startEnrollment(true);const account=original.state.anonymous.account_id;
 await h.db.run('UPDATE auth_challenges SET created_at=?,expires_at=? WHERE id=?',Date.now()-130000,Date.now()-1000,original.challenge.challenge_id);
 await assert.rejects(original.restartEnrollment(),/lost_committed_refresh_reply/);const key=original.state.refreshDelivery.rotation_key;
 const restored=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});
 await restored.restore();assert.equal(restored.state.refreshDelivery.rotation_key,key);await restored.restartEnrollment();
 assert.equal(refreshPosts,2);assert.equal(restored.state.refreshDelivery,null);assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',account)).n,2);
 await restored.useCapture(new Uint8Array([0xff,0xd8,0xff,0xe0,91]));assert.equal(restored.captures.length,1);await h.close();
});
test('logout cancels a prepared refresh before its delayed first dispatch and never restores authority',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),base='http://localhost',idb=new IDBFactory();let release,entered;
 const ready=new Promise(resolve=>entered=resolve);
 const fetch=async(url,init)=>{const path=new URL(url).pathname;
   if(path==='/auth/session/refresh'){entered();await new Promise(resolve=>release=resolve);}
   return h.request(path,{method:init.method,raw:init.body,headers:init.headers});};
 const session=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});
 await session.startEnrollment(true);const rotating=session.refreshAnonymous();await ready;await session.logout();release();await assert.rejects(rotating,{code:'session_changed'});
 assert.equal(session.credentials,null);assert.equal(session.operator,null);assert.equal(session.state.refreshDelivery.retired,true);assert.equal(session.state.refreshDelivery.cancelled,true);
 const restored=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});await restored.restore();
 await assert.rejects(restored.refreshAnonymous(),{code:'refresh_delivery_scope_changed'});assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',session.state.anonymous.account_id)).n,1);await h.close();
});
test('logout during successor vault encryption retires the visible attempt and revokes its successor',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),base='http://localhost',idb=new IDBFactory();let release,entered,gate=true,successor,cancels=0;
 const fetch=async(url,init)=>{const path=new URL(url).pathname;if(path.endsWith('/refresh/cancel'))cancels++;
   const response=await h.request(path,{method:init.method,raw:init.body,headers:init.headers});
   if(path==='/auth/session/refresh'&&response.ok)successor=await response.clone().json();return response;};
 const session=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});await session.startEnrollment(true);
 const ready=new Promise(resolve=>entered=resolve),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
 crypto.subtle.encrypt=async(...args)=>{let value;try{value=JSON.parse(new TextDecoder().decode(args[2]));}catch{}
   if(gate&&value?.refreshDelivery===null&&value?.anonymous?.protocol==='lovelies-refresh-delivery-v1'){gate=false;entered();await new Promise(resolve=>release=resolve);}return encrypt(...args);};
 try{
   const rotating=session.refreshAnonymous().then(()=>null,error=>error);await ready;await session.logout();release();assert(['private_state_changed','session_changed'].includes((await rotating).code));
   const restored=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});await restored.restore();
   assert.equal(cancels,1);assert.equal(restored.state.refreshDelivery.retired,true);assert.equal(restored.state.refreshDelivery.cancelled,true);assert.equal(restored.credentials,null);
   assert.equal((await h.request('/me',{token:successor.access_token})).status,401);
 }finally{release?.();crypto.subtle.encrypt=encrypt;await h.close();}
});
test('stale logout and later signed recovery preserve a newer tab session and enrollment generation',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),base='http://localhost',idb=new IDBFactory();let release,entered,gate=true;
 const fetch=(url,init)=>h.request(new URL(url).pathname,{method:init.method,raw:init.body,headers:init.headers});
 const original=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});await original.startEnrollment(true);
 await h.db.run('UPDATE auth_challenges SET created_at=?,expires_at=? WHERE id=?',Date.now()-130000,Date.now()-1000,original.challenge.challenge_id);
 const ready=new Promise(resolve=>entered=resolve),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
 crypto.subtle.encrypt=async(...args)=>{let value;try{value=JSON.parse(new TextDecoder().decode(args[2]));}catch{}
   if(gate&&value?.refreshDelivery===null&&value?.anonymous?.protocol==='lovelies-refresh-delivery-v1'){gate=false;entered();await new Promise(resolve=>release=resolve);}return encrypt(...args);};
 try{
   const rotating=original.refreshAnonymous().then(()=>null,error=>error);await ready;
   const newer=new OperatorSession({baseUrl:base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault:new OperatorVault(base,idb),fetch});await newer.restore();
   await newer.refreshAnonymous();await newer.restartEnrollment();
   const latest=await new OperatorVault(base,idb).load();assert.equal(latest.enrollment.challenge.enrollment_generation,2);
   await assert.rejects(original.logout(),{code:'private_state_changed'});release();assert(['private_state_changed','session_changed'].includes((await rotating).code));
   await original.recoverEnrollment();const saved=await new OperatorVault(base,idb).load();
   assert.equal(saved.anonymous.refresh_token,latest.anonymous.refresh_token);assert.equal(saved.refreshDelivery,null);
   assert.equal(saved.enrollment.challenge.enrollment_generation,2);assert.equal((await h.request('/me',{token:saved.anonymous.access_token})).status,200);
   assert.equal(original.credentials,null);assert.equal(original.operator,null);
 }finally{release?.();crypto.subtle.encrypt=encrypt;await h.close();}
});
