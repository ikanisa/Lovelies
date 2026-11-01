import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notificationRosterFixture} from './notification-roster-fixture.mjs';
import {retirePushSubject} from '../src/push-roster.ts';
import {eraseNotificationSubject} from '../src/notifications.ts';
import {createApp} from '../src/index.ts';
import {startHarness} from './runtime-harness.mjs';

test('erasure requires independent permanent retirement and refuses unresolved attempts even with a copied proof',{timeout:40000},async t=>{
  const f=await notificationRosterFixture(t,{devices:1,send:async()=>({status:'ambiguous'})});
  await assert.rejects(f.process,error=>error?.code==='push_reconciliation_required');
  await assert.rejects(()=>retirePushSubject(f.h.app,f.account),error=>error?.code==='push_subject_reconciliation_required');
  assert.equal((await f.receipts()).length,1);
  await assert.rejects(()=>f.h.db.transaction(()=>eraseNotificationSubject(f.h.app,f.account,null)),error=>error?.code==='push_subject_retirement_required');
  const unresolved=(await f.receipts())[0];await f.provider.roster.finish(unresolved.operation_key,{status:'accepted',provider_message_id:'accepted-before-erasure'});
  const proof=await retirePushSubject(f.h.app,f.account);assert.equal(proof.dispatch_quiescent,true);assert.equal(proof.provider_erasure_verified,false);
  assert.equal((await f.receipts())[0].status,'accepted');
  await assert.rejects(()=>f.h.db.transaction(()=>eraseNotificationSubject(f.h.app,f.account,{...proof})),error=>error?.code==='push_subject_retirement_required');
  await assert.rejects(()=>f.h.db.transaction(()=>eraseNotificationSubject(f.h.app,f.account,{...proof,subject_sha256:'a'.repeat(64)})),error=>error?.code==='push_subject_retirement_required');
  await f.h.db.transaction(()=>eraseNotificationSubject(f.h.app,f.account,proof));
  assert.equal((await f.receipts()).length,0);assert.equal(await f.job(),null);
  const delayed=await f.provider.plan({subject:proof.subject_sha256});await assert.rejects(()=>f.provider.roster.plan(delayed.plan),/subject_retired/);
});

test('empty production SQL cannot replace a retirement proof; legacy no-provider local fixtures remain explicit',{timeout:40000},async t=>{
  const h=await startHarness({consumeQueue:false});t.after(()=>h.close());const subject=crypto.randomUUID();
  assert.equal(await retirePushSubject(h.app,subject),null);
  await h.db.transaction(()=>eraseNotificationSubject(h.app,subject,null));
  const production=createApp(h.db,{...h.env,APP_ENV:'production'});
  await assert.rejects(()=>retirePushSubject(production,subject),error=>error?.code==='push_roster_configuration_required');
  await assert.rejects(()=>h.db.transaction(()=>eraseNotificationSubject(production,subject,null)),error=>error?.code==='push_roster_configuration_required');
});
