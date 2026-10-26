import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';

after(closeHarnesses);

async function rows(h){
  const tables=await h.db.all("SELECT tablename FROM pg_tables WHERE schemaname='lovelies_private' ORDER BY tablename");
  const hashes={};
  for(const {tablename} of tables){
    assert.match(tablename,/^[a-z_]+$/);
    const records=await h.db.all(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`);
    hashes[tablename]=createHash('sha256').update(JSON.stringify(records)).digest('hex');
  }
  assert.equal(tables.length,69);
  return hashes;
}

for(const version of [8,13,null])test(`database schema ${version??'missing'} gates existing and new requests without changing any private rows`,async()=>{
  const h=await startHarness({consumeQueue:false});
  try{
    const guest=await h.anonymous({adult:true});
    await h.json('/me',{token:guest.access_token});
    const history=await h.db.all('SELECT version,applied_at FROM schema_versions ORDER BY version');
    await h.db.transaction(async()=>{
      await h.db.run('DELETE FROM schema_versions');
      if(version!==null)await h.db.run('INSERT INTO schema_versions(version,applied_at) VALUES(?,?)',version,1700000000000);
    });
    const before=await rows(h),calls=[];
    // Any external path is a failure, including a read-only readiness probe.
    h.env.MODEL_SERVICE_READINESS=async()=>{calls.push('inference');return true;};
    h.env.STORE_VERIFIER={fetch:async()=>{calls.push('store');throw new Error('unexpected_store_call');}};
    h.env.PUSH_SERVICE={fetch:async()=>{calls.push('push');throw new Error('unexpected_push_call');}};
    for(const path of ['/health','/ready']){
      const health=await h.json(path,{},503);
      assert.equal(health.database_ready,false);assert.equal(health.schema_version,version);
    }
    for(const [path,options] of [
      ['/functions/v1/lovelies-api/auth/anonymous',{body:{}}],
      ['/lovelies-api/auth/session/refresh',{body:{refresh_token:guest.refresh_token}}],
      ['/me',{token:guest.access_token}],
      ['/auth/logout',{token:guest.access_token,body:{}}],
      ['/privacy/account-deletion',{token:guest.access_token,body:{operation_key:crypto.randomUUID(),status_token:'lvd_'+'a'.repeat(64)}}],
      ['/_internal/maintenance',{body:{},headers:{authorization:'Bearer '+h.env.INTERNAL_MAINTENANCE_SECRET}}],
    ]){
      const response=await h.request(path,options);
      assert.equal(response.status,503,path);
      assert.deepEqual(await response.json(),{error:{code:'database_schema_not_ready'}},path);
      assert.equal(response.headers.get('cache-control'),'no-store, private');
    }
    // Maintenance remains private while unavailable; ordinary CORS preflight
    // still works so the application can display the eventual 503 response.
    await h.json('/_internal/maintenance',{body:{},headers:{authorization:'Bearer wrong-fixture-secret'}},404);
    await h.json('/_internal/unknown',{},404);
    const preflight=await h.request('/auth/anonymous',{method:'OPTIONS',headers:{origin:'http://127.0.0.1:8765'}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'http://127.0.0.1:8765');await preflight.body?.cancel();
    assert.deepEqual(await rows(h),before,'No account, session, rate limit, job or cleanup row may change');
    // Re-check within the same handler, rather than caching a startup result.
    await h.db.transaction(async()=>{
      await h.db.run('DELETE FROM schema_versions');
      for(const row of history)await h.db.run('INSERT INTO schema_versions(version,applied_at) VALUES(?,?)',row.version,row.applied_at);
    });
    await h.json('/health');await h.json('/me',{token:guest.access_token});
    await h.json('/auth/logout',{token:guest.access_token,body:{}});
    await h.json('/me',{token:guest.access_token},401);
    assert.deepEqual(calls,[]);
  }finally{await h.close();}
});
