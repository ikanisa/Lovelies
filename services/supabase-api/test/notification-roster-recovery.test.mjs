import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notificationRosterFixture} from './notification-roster-fixture.mjs';

test('complete independent plan repairs rolled-back SQL and deleted devices with GET only and no resend',{timeout:40000},async t=>{
  const f=await notificationRosterFixture(t);await f.process();
  assert.equal(f.provider.sent.length,2);assert.equal((await f.job()).status,'accepted');assert.equal((await f.receipts()).length,2);
  assert.throws(()=>f.provider.storage.database.prepare('DELETE FROM push_roster_plans_v2').run(),/immutable_push_roster/);
  await assert.rejects(()=>f.h.db.run("UPDATE notification_dispatch_plans SET plan_sha256=? WHERE notification_id=?",'a'.repeat(64),f.notification),/notification_dispatch_plan_immutable/);
  // Model a restored application snapshot that has the original notification
  // job but none of the later dispatch/receipt/device rows. Independent storage
  // and its pinned immutable plan deliberately remain outside that rollback.
  await f.h.db.transaction(async()=>{
    await f.h.db.run('DELETE FROM notification_recovered_receipts WHERE notification_id=?',f.notification);
    await f.h.db.run('DELETE FROM notification_dispatch_plans WHERE notification_id=?',f.notification);
    await f.h.db.run('DELETE FROM push_devices WHERE account_id=?',f.account);
    await f.h.db.run("UPDATE notification_jobs SET status='queued' WHERE notification_id=?",f.notification);
  });
  f.calls.length=0;await f.process();
  assert.equal(f.provider.sent.length,2);assert.equal((await f.job()).status,'accepted');assert.equal((await f.receipts()).length,2);
  assert(f.calls.length>0&&f.calls.every(call=>call.method==='GET'));assert((await f.receipts()).every(row=>row.status==='accepted'));
});

test('one uncertain active device cannot block another; retirement preserves later acceptance after opt-out',{timeout:40000},async t=>{
  let count=0;
  const f=await notificationRosterFixture(t,{send:async value=>++count===1?{status:'ambiguous'}:{status:'accepted',provider_message_id:'accepted-second-device'}});
  await assert.rejects(f.process,error=>error?.code==='push_reconciliation_required');
  assert.equal(f.provider.sent.length,2);assert.equal((await f.job()).status,'ambiguous');
  let receipts=await f.receipts();assert.equal(receipts.filter(row=>row.status==='accepted').length,1);
  const unresolved=receipts.find(row=>row.status!=='accepted');
  await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',f.account,Date.now());
  await f.h.db.run("UPDATE push_devices SET active=0,token_value='' WHERE account_id=?",f.account);
  await f.provider.roster.finish(unresolved.operation_key,{status:'accepted',provider_message_id:'late-acceptance-after-opt-out'});
  f.calls.length=0;await f.process();assert.equal((await f.job()).status,'accepted');assert.equal(f.provider.sent.length,2);
  assert(!f.calls.some(call=>call.path==='/send'));receipts=await f.receipts();assert(receipts.every(row=>row.status==='accepted'));
});

test('missing roster history and changed bootstrap/configuration cannot authorize fallback or new sends',{timeout:40000},async t=>{
  const f=await notificationRosterFixture(t,{devices:1,send:async()=>({status:'ambiguous'})});
  await assert.rejects(f.process,error=>error?.code==='push_reconciliation_required');const before=await f.receipts();
  f.h.env.PUSH_LEDGER_BOOTSTRAP_ID=crypto.randomUUID();
  await assert.rejects(f.process,error=>error?.code==='push_roster_unverified');assert.deepEqual(await f.receipts(),before);
  delete f.h.env.PUSH_LEDGER_BOOTSTRAP_ID;delete f.h.env.PUSH_LEDGER_ID;delete f.h.env.PUSH_PROVIDER_GENERATION;
  await assert.rejects(f.process,error=>error?.code==='push_roster_configuration_required');assert.equal(f.provider.sent.length,1);
});
