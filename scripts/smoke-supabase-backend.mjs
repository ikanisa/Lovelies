/** Read-only health probes; never creates an account or sends a provider job. */
import assert from 'node:assert/strict';
import {apiBase} from '../admin/operator-session.mjs';
const base=apiBase(process.env.LOVELIES_SMOKE_API_URL??'http://127.0.0.1:8787');
for(const route of ['/health','/ready']){
 const response=await fetch(base+route,{redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});
 const value=await response.json();assert.equal(response.status,200,route+' unavailable');
 assert.equal(value.service,'lovelies-supabase-api');assert.equal(value.database,'supabase_postgresql');assert.equal(value.database_ready,true);
 assert.equal(value.verification,'registered_face_comparison');assert.equal(value.liveness_required,false);assert.deepEqual(value.missing,[]);
 console.log(route+' passed; infrastructure readiness only, provider/device acceptance remains independent.');
}
