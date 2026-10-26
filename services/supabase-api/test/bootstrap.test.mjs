import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture} from './runtime-harness.mjs';
after(closeHarnesses);
test('PostgreSQL schema, anonymous-first session and three signed captures upgrade the same account',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture});
 const anonymous=await h.anonymous({adult:true});
 assert.equal(anonymous.auth_method,'anonymous');
 await h.json('/me/gallery',{token:anonymous.access_token},403);
 const person=await enroll(h);
 const me=await h.json('/functions/v1/lovelies-api/me',{token:person.token});
 assert.equal(me.user_id,person.accountId);assert.equal(me.authenticated,true);
 const claims=JSON.parse(Buffer.from(person.token.split('.')[1],'base64url').toString());assert.equal(claims.iss,'lovelies-supabase');
 const health=await h.json('/health');assert.equal(health.database,'supabase_postgresql');assert.equal(health.schema_version,12);
 await h.close();
});
