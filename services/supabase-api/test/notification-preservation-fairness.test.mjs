import { pushReceipt } from './notification-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startHarness, enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { createApp } from '../src/index.ts';
import { enqueueNotification, processNotificationJob, flushNotificationOutbox } from '../src/notifications.ts';
import { PostgresJobQueue } from '../src/jobs.ts';

const originalFetch = globalThis.fetch;
if (process.env.TEST_DATABASE_URL === undefined) {
  globalThis.fetch = async () => { throw Error('network_denied_by_fixture'); };
  after(() => { globalThis.fetch = originalFetch; });
}
const key = () => crypto.randomUUID();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const unconfirmed = error => error?.status === 503 && error.code === 'push_reconciliation_required';
const retainedEvidence = ({updated_at: _examinedAt, ...row}) => row;

async function setup(t) {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false }); t.after(() => h.close());
  const actor = await enroll(h), token = 'synthetic-token-' + key();
  const device = await h.json('/me/push-devices', { token: actor.token, body: { platform: 'android', push_token: token, operation_key: key() } });
  const push = await h.db.one('SELECT token_hash FROM push_devices WHERE id=?', device.id);
  return { h, actor, device, token, push };
}
async function delivery(f, { status = 'ambiguous', attempts = 1, receipt = null, lease = null } = {}) {
  const note = await f.h.db.transaction(() => enqueueNotification(f.h.app, f.actor.accountId, 'support', key(), 'Synthetic notice'));
  const id = key(), now = Date.now();
  await f.h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,lease_token,lease_until,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, note, f.device.id, 'notification:' + note + ':' + f.device.id, status, f.push.token_hash, receipt, lease, lease ? now + 60000 : null, attempts, now, now);
  return { id, note, before: await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?', id) };
}

test('opt-out cancels only pristine delivery and preserves attempted, leased, accepted and opaque job history', { timeout: 30000 }, async t => {
  const f = await setup(t), rows = [];
  for (const value of [{ status: 'queued', attempts: 0 }, { status: 'queued', attempts: 1 },
    { status: 'queued', attempts: 0, receipt: '' }, { status: 'queued', attempts: 0, lease: key() },
    { status: 'dispatching', attempts: 1, lease: key() }, { status: 'ambiguous' },
    { status: 'accepted', receipt: 'synthetic-receipt' }]) rows.push(await delivery(f, value));
  const opaque = await f.h.db.transaction(() => enqueueNotification(f.h.app, f.actor.accountId, 'support', key(), 'Synthetic notice'));
  await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?", opaque);
  await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)', f.actor.accountId, Date.now());
  for (const [index, row] of rows.entries()) {
    if (index === 0 || index === 6) await processNotificationJob({ notification_id: row.note }, f.h.app);
    else await assert.rejects(() => processNotificationJob({ notification_id: row.note }, f.h.app), error =>
      error?.status===503 && error.code===(index===3||index===4?'push_reconciliation_required':'push_delivery_binding_unavailable'));
    const after = await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?', row.id);
    if (index === 0) assert.equal(after.status, 'cancelled'); else assert.deepEqual(retainedEvidence(after), retainedEvidence(row.before));
    assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?', row.note)).status, index === 0 ? 'cancelled' : index===6?'accepted':'ambiguous');
  }
  await assert.rejects(() => processNotificationJob({ notification_id: opaque }, f.h.app), unconfirmed);
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?', opaque)).status, 'ambiguous');
  await flushNotificationOutbox(f.h.app);
  for (const row of rows.slice(1)) assert.deepEqual(retainedEvidence(await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?', row.id)), retainedEvidence(row.before));
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?', opaque)).status, 'ambiguous');
});

test('inactive token transfer does not cancel the old account ambiguous or accepted attempts', { timeout: 30000 }, async t => {
  const f = await setup(t), ambiguous = await delivery(f), accepted = await delivery(f, { status: 'accepted', receipt: 'synthetic-receipt' });
  await f.h.json('/me/push-devices/' + f.device.id, { token: f.actor.token, method: 'DELETE', body: { operation_key: key() } });
  const other = await enroll(f.h);
  const next = await f.h.json('/me/push-devices', { token: other.token, body: { platform: 'android', push_token: f.token, operation_key: key() } });
  assert.notEqual(next.id, f.device.id);
  for (const row of [ambiguous, accepted]) assert.deepEqual(await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?', row.id), row.before);
  assert.equal((await f.h.db.one('SELECT account_id FROM push_devices WHERE id=?', f.device.id)).account_id, f.actor.accountId);
});

test('an accepted reply after opt-out remains historical evidence and never authorizes another send', { timeout: 30000 }, async t => {
  const f = await setup(t), note = await f.h.db.transaction(() => enqueueNotification(f.h.app, f.actor.accountId, 'support', key(), 'Synthetic notice'));
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let sends = 0;
  f.h.env.PUSH_SERVICE = { fetch: async (_url, init) => {
    assert.equal(init.method, 'POST'); sends++; const body = JSON.parse(init.body); entered.resolve(); await release.promise;
    return Response.json(pushReceipt(body,{ status: 'accepted', provider_message_id: 'synthetic-late-acceptance' }));
  } };
  const pending = processNotificationJob({ notification_id: note }, f.h.app); void pending.catch(() => {});
  await entered.promise;
  await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)', f.actor.accountId, Date.now());
  await assert.rejects(() => processNotificationJob({ notification_id: note }, f.h.app), unconfirmed);
  release.resolve(); await pending;
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt,lease_token FROM notification_deliveries WHERE notification_id=?', note), { status: 'accepted', provider_receipt: 'synthetic-late-acceptance', lease_token: null });
  await processNotificationJob({ notification_id: note }, f.h.app);
  assert.notEqual((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?', note)).status, 'cancelled');
  assert.equal(sends, 1);
});

test('25 terminal queue conflicts cannot starve a newer notification; scan examination is not dispatch', { timeout: 30000 }, async t => {
  const h = await startHarness({ consumeQueue: false }); t.after(() => h.close());
  const now = 1700000000000, account = key(), ids = [], ctx = createApp(h.db, h.env, () => now);
  await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state) VALUES(?,'Synthetic subject',?,'registered_face')", account, now);
  for (let i = 0; i < 26; i++) {
    const id = key(); ids.push(id);
    await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic',?)", id, account, key(), now + i);
    await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'queued',?)", id, account, now + i);
    if (i < 25) {
      await new PostgresJobQueue(h.db, () => now).send({ category: 'notification', payload: { notification_id: id } });
      await h.db.run("UPDATE job_queue SET state='failed' WHERE payload_json LIKE ?", '%' + id + '%');
    }
  }
  await assert.rejects(() => flushNotificationOutbox(ctx), error => error?.code === 'job_queue_reconciliation_required');
  assert.equal((await h.db.one('SELECT count(*) n FROM notification_jobs WHERE last_examined_at=?', now)).n, 25);
  assert.equal((await h.db.one('SELECT count(*) n FROM notification_jobs WHERE dispatched_at IS NOT NULL')).n, 0);
  await flushNotificationOutbox(ctx);
  const fresh = await h.db.one('SELECT status,dispatched_at,last_examined_at FROM notification_jobs WHERE notification_id=?', ids[25]);
  assert.deepEqual(fresh, { status: 'dispatched', dispatched_at: now, last_examined_at: now });
  assert.equal((await h.db.one("SELECT count(*) n FROM job_queue WHERE state='pending'")).n, 1);
});
