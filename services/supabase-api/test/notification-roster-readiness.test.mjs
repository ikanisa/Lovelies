import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notificationRosterFixture} from './notification-roster-fixture.mjs';
import {pushRosterReady} from '../src/push-roster.ts';

test('push readiness requires serving exact bootstrap and actual provider generation',{timeout:40000},async t=>{
  const f=await notificationRosterFixture(t,{devices:0});assert.equal(await pushRosterReady(f.h.app),true);
  const unusedInference={fetch:async()=>{throw Error('Readiness must not run inference');}};
  f.h.env.FACE_AUTH_VERIFIER=unusedInference;f.h.env.PHOTO_PROCESSOR=unusedInference;
  f.h.env.MODEL_SERVICE_READINESS=async()=>true;
  const healthy=await f.h.json('/ready');
  assert.equal(healthy.push_roster_ready,true);assert.equal(healthy.database_ready,true);
  assert.equal(healthy.inference_ready,true);
  f.h.env.PUSH_LEDGER_BOOTSTRAP_ID=crypto.randomUUID();assert.equal(await pushRosterReady(f.h.app),false);
  const wrongBootstrap=await f.h.json('/ready',{},503);
  assert.equal(wrongBootstrap.push_roster_ready,false);assert.equal(wrongBootstrap.database_ready,true);
  assert.equal((await f.h.json('/health')).status,'ok');
  f.h.env.PUSH_LEDGER_BOOTSTRAP_ID=f.provider.bootstrap;f.h.env.PUSH_PROVIDER_GENERATION='a'.repeat(64);assert.equal(await pushRosterReady(f.h.app),false);
  f.h.env.PUSH_PROVIDER_GENERATION=f.provider.generation;
  const service=f.h.env.PUSH_SERVICE;delete f.h.env.PUSH_SERVICE;
  const missing=await f.h.json('/ready',{},503);
  assert.equal(missing.push_roster_ready,false);assert.ok(missing.missing.includes('PUSH_SERVICE'));
  f.h.env.PUSH_SERVICE=service;
  await f.provider.send('/v2/fence',f.provider.envelope({reason:'storage_integrity_unconfirmed'}));
  assert.equal(await pushRosterReady(f.h.app),false);
  assert.equal((await f.h.json('/ready',{},503)).push_roster_ready,false);
});
