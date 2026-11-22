/** Unexecuted local proposals; one registered synthetic operator is also the
 * sole asset subject. No hosted or cross-account simulation is performed. */
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { runRetention } from '../src/retention.ts';
import { prepareOperation } from '../src/operations.ts';
import { restoreAllocationID, restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, digest } from './restore-database-fixture.mjs';

// Never run PGlite callbacks when a database target is defined, even empty.
const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;
const DAY = 86400000;
const operation = label => label + '-' + randomUUID();

async function setup(t) {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external database forbidden');
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData(); return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const actor = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', actor.accountId);
  const login = async () => {
    const challenge = await h.json('/auth/face/challenge', { body: { face_handle: actor.faceHandle, device_id: actor.deviceId } }, 201);
    const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, actor.keys.privateKey) });
    assert(credentials.roles.includes('admin')); return credentials.access_token;
  };
  let token = await login();
  let offset = 0; const clock = () => h.app.now() + offset;
  const context = createApp(f.db, h.env, clock), handler = createHandler(context), request = async (path, body, method = 'POST') => {
    const response = await handler(new Request('https://api.invalid' + path, { method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const schedule = body => request('/admin/retention/run', body);
  const now = h.app.now(), assets = [];
  const add = async days => {
    const id = randomUUID(), version = randomUUID(), key = `synthetic/${actor.accountId}/asset/${id}`;
    await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
      VALUES(?,?,'personal','ready',?,'image/png',3,?,'Synthetic fixture',?)`, id, actor.accountId, key, version, now - days * DAY);
    await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
      id, now - DAY, now + DAY, 0, 1, now); await h.env.QUARANTINE.put(key, new Uint8Array([1, 2, 3]));
    const asset = { id, version, key }; assets.push(asset); return asset;
  };
  const op = a => restoreOperationID(actor.accountId, 'retention.raw-expiry-v1',
    'retention.raw:' + digest(stable({ asset_id: a.id, asset_version: a.version })));
  const receipt = body => h.db.one('SELECT * FROM operations WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, 'retention', body.operation_key);
  const command = body => h.db.one('SELECT * FROM retention_schedule_commands WHERE actor_id=? AND source=? AND operation_key=?', actor.accountId, 'retention', body.operation_key);
  return { ...f, h, actor, now, assets, add, op, receipt, command, login, context, clock, advance: ms => { offset += ms; }, setOffset: ms => { offset = ms; }, setToken: value => { token = value; }, request, schedule };
}

test('manual schedule commits exact asset facts and replays its original receipt without redoing work', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('operator-schedule') };
  const result = await f.schedule(body); assert.equal(result.status, 200); assert.deepEqual(result.body, { scheduled: true, operation_key: body.operation_key });
  for (const a of [first, second]) {
    const saved = await f.journal.lookup(await f.op(a)); assert.equal(saved.status, 'committed');
    assert.deepEqual(saved.plan.events.map(e => ({ kind: e.kind, scope: e.scope })), [{ kind: 'asset-retired', scope: { owner_id: f.actor.accountId, asset_id: a.id, asset_version: a.version } }]);
    assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'expired');
    assert.equal((await f.h.db.one('SELECT status FROM retention_jobs WHERE asset_id=?', a.id)).status, 'pending');
    assert(await f.h.env.QUARANTINE.head(a.key));
  }
  assert.equal(await f.command(body), null); const savedReceipt = await f.receipt(body);
  assert.deepEqual(await f.schedule(body), result); assert.deepEqual(await f.receipt(body), savedReceipt);
  assert.equal((await f.schedule({ ...body, limit: 1 })).status, 409);
});

test('a lost committed asset reply resumes the same plan with the same allocations', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('resume-schedule') };
  const firstID = await f.op(first), prepare = f.journal.prepare.bind(f.journal); let injected = false;
  f.journal.prepare = async (input, ...args) => {
    const result = await prepare(input, ...args);
    if (!injected && input.operation_id === firstID) { injected = true; f.faults.commitReply = true; }
    return result;
  };
  assert((await f.schedule(body)).status >= 500); assert(injected);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', first.id)).status, 'expired');
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  assert.equal((await f.command(body)).next_position, 1); assert.equal((await f.journal.lookup(firstID)).status, 'pending');
  const result = await f.schedule(body); assert.equal(result.status, 200); assert.deepEqual(result.body, { scheduled: true, operation_key: body.operation_key });
  const saved = await f.journal.lookup(firstID); assert.equal(saved.status, 'committed');
  assert.equal((await f.h.db.one('SELECT id FROM retention_jobs WHERE asset_id=?', first.id)).id, await restoreAllocationID(firstID, 'id_0'));
  assert.equal((await f.journal.lookup(await f.op(second))).status, 'committed'); assert.equal(await f.command(body), null);
});

test('a prepare accepted without a SQL commit leaves the plan fenced and stops later work', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('prepare-schedule') };
  const firstID = await f.op(first), prepare = f.journal.prepare.bind(f.journal); let injected = false;
  f.journal.prepare = async (input, ...args) => {
    if (!injected && input.operation_id === firstID) { injected = true; f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' }; }
    return prepare(input, ...args);
  };
  assert.equal((await f.schedule(body)).status, 503); assert(injected); assert.equal((await f.journal.lookup(firstID)).status, 'pending');
  assert.equal((await f.command(body)).next_position, 0); assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  assert.equal((await f.schedule(body)).status, 503); assert.equal(await f.journal.lookup(await f.op(second)), null);
});

test('revoking the operator between steps stops progress; a fresh session resumes the same receipt', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('reauth-schedule') };
  const firstID = await f.op(first), prepare = f.journal.prepare.bind(f.journal); let armed = false, revoked = false;
  f.journal.prepare = async (input, ...args) => { const result = await prepare(input, ...args); if (input.operation_id === firstID) armed = true; return result; };
  f.faults.afterCommit = async () => { if (armed && !revoked) { revoked = true; await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.now, f.actor.accountId); } };
  assert([401, 403].includes((await f.schedule(body)).status)); assert(revoked);
  assert.equal((await f.command(body)).next_position, 1); assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  f.setToken(await f.login()); const result = await f.schedule(body); assert.equal(result.status, 200);
  assert.equal((await f.journal.lookup(await f.op(second))).status, 'committed'); assert.equal(await f.command(body), null);
});

test('a replaced asset after reservation is not retired as its previously planned version', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('changed-source') };
  const operationID = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  let armed = false, changed = false, replacement = randomUUID();
  f.journal.prepare = async (input, ...args) => { const result = await prepare(input, ...args); if (input.operation_id === operationID) armed = true; return result; };
  f.faults.afterCommit = async () => { if (armed && !changed) { changed = true; await f.h.db.run('UPDATE assets SET version=? WHERE id=?', replacement, second.id); } };
  const result = await f.schedule(body); assert.equal(result.status, 200); assert(changed);
  const current = await f.h.db.one('SELECT version,status FROM assets WHERE id=?', second.id);
  assert.equal(current.version, replacement); assert.equal(current.status, 'ready'); assert.equal(await f.journal.lookup(await f.op(second)), null);
  assert.equal((await f.journal.lookup(await f.op(first))).status, 'committed');
});

test('erasing an asset from a pending plan cascades its identifier and prevents a false success', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('lost-item') };
  const operationID = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  let armed = false, erased = false;
  f.journal.prepare = async (input, ...args) => { const result = await prepare(input, ...args); if (input.operation_id === operationID) armed = true; return result; };
  f.faults.afterCommit = async () => { if (armed && !erased) { erased = true; await f.h.db.run('DELETE FROM assets WHERE id=?', second.id); } };
  const result = await f.schedule(body); assert.equal(result.status, 503); assert(erased);
  const command = await f.command(body); assert(command); assert.equal(command.planned_count, 2);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_schedule_items WHERE command_id=?', command.id)).n, 1);
  assert.equal((await f.receipt(body)).response_json.includes('scheduled'), false); assert.equal(await f.journal.lookup(await f.op(first)), null);
});

test('old successful receipt replays and same-key pending reservations conflict with a retention update', async t => {
  const f = await setup(t), body = { limit: 1, operation_key: operation('old-schedule') }, intent = await prepareOperation('retention.schedule', body, 'retention');
  const original = { scheduled: true, operation_key: body.operation_key };
  await f.h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    f.actor.accountId, 'retention', intent.key, intent.action, intent.hash, intent.payloadJson, stable(original), f.now);
  assert.deepEqual(await f.schedule(body), { status: 200, body: original });
  const pending = { limit: 1, operation_key: operation('pending-key') }, first = await f.add(80), firstID = await f.op(first), prepare = f.journal.prepare.bind(f.journal);
  let injected = 0;
  f.journal.prepare = async (input, ...args) => { if (input.operation_id === firstID) { injected++; throw Error('synthetic_prepare_not_sent'); } return prepare(input, ...args); };
  assert((await f.schedule(pending)).status >= 500); assert.equal(injected, 1, 'the synthetic prepare failure must run exactly once'); assert(await f.command(pending));
  f.journal.prepare = prepare;
  const policy = await f.h.db.one("SELECT * FROM retention_settings WHERE id='default'");
  const update = await f.request('/admin/retention', { legal_hold: 0, expected_version: policy.version, operation_key: pending.operation_key }, 'PATCH');
  assert.equal(update.status, 409); assert(await f.command(pending));
  assert.equal((await f.schedule(pending)).status, 200);
});

test('concurrent same-key operator retries return the same receipt and do not duplicate asset jobs', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('concurrent-schedule') };
  const [left, right] = await Promise.all([f.schedule(body), f.schedule(body)]);
  assert.deepEqual(left, right); assert.equal(left.status, 200); assert.deepEqual(left.body, { scheduled: true, operation_key: body.operation_key });
  for (const a of [first, second]) {
    assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_jobs WHERE asset_id=?', a.id)).n, 1);
    assert.equal((await f.journal.lookup(await f.op(a))).status, 'committed');
  }
  assert.equal(await f.command(body), null);
});

test('concurrent changed payloads using one operation key cannot both succeed', async t => {
  const f = await setup(t), first = await f.add(80), body = { limit: 1, operation_key: operation('concurrent-conflict') };
  const results = await Promise.all([f.schedule(body), f.schedule({ ...body, limit: 2 })]);
  assert.deepEqual(results.map(result => result.status).sort((a, b) => a - b), [200, 409]);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_jobs WHERE asset_id=?', first.id)).n, 1);
  assert.equal((await f.journal.lookup(await f.op(first))).status, 'committed');
});

test('preview-only operator work records a deterministic step and cleanup-job allocation', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('preview-schedule') };
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, a.id);
  const result = await f.schedule(body); assert.equal(result.status, 200);
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), command = await restoreAllocationID(reservation, 'id_0');
  const stepKey = 'retention.step:' + digest(stable({ command_id: command, position: 0 }));
  const step = await restoreOperationID(f.actor.accountId, 'retention.schedule.step-v1', stepKey), saved = await f.journal.lookup(step);
  assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.events, []);
  assert.equal(saved.plan.allocations.id_0, await restoreAllocationID(step, 'id_0'));
  const job = await f.h.db.one('SELECT * FROM retention_jobs WHERE asset_id=?', a.id);
  assert.equal(job.id, saved.plan.allocations.id_0); assert.equal(job.kind, 'preview');
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready'); assert(await f.h.env.QUARANTINE.head(a.key));
});

test('a cursor inconsistent with its pending item outcomes cannot return a successful receipt', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('corrupt-cursor') };
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  let armed = false, changed = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === reservation) armed = true; return value; };
  f.faults.afterCommit = async () => {
    if (armed && !changed) { changed = true; await f.h.db.run("UPDATE retention_schedule_commands SET next_position=planned_count WHERE actor_id=? AND source='retention' AND operation_key=?", f.actor.accountId, body.operation_key); }
  };
  assert.equal((await f.schedule(body)).status, 503); assert(changed);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', first.id)).status, 'ready');
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  assert.equal(await f.journal.lookup(await f.op(first)), null); assert.equal(await f.journal.lookup(await f.op(second)), null);
});

test('a mismatched completed item identity cannot advance to a successful receipt', async t => {
  const f = await setup(t), first = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('corrupt-step') };
  const firstOp = await f.op(first), prepare = f.journal.prepare.bind(f.journal); let armed = false, changed = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === firstOp) armed = true; return value; };
  f.faults.afterCommit = async () => { if (armed && !changed) {
    changed = true; await f.h.db.run("UPDATE retention_schedule_items SET completion_id=? WHERE asset_id=? AND outcome='raw'", randomUUID(), first.id);
  } };
  assert.equal((await f.schedule(body)).status, 503); assert(changed);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  assert.equal(await f.journal.lookup(await f.op(second)), null);
});

for (const blocker of ['global-hold', 'asset-hold', 'moderation-hold', 'request-hold', 'pending-writer', 'extended-deadline', 'source-change'])
  test(`a temporary ${blocker} after reservation leaves the item pending and same-key retry resumes`, async t => {
    const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('deferred-' + blocker) };
    const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
    const holdID = randomUUID(), writerID = randomUUID(); let armed = false, inserted = false;
    f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === reservation) armed = true; return value; };
    f.faults.afterCommit = async () => { if (armed && !inserted) {
      inserted = true;
      if (blocker === 'global-hold') await f.h.db.run("UPDATE retention_settings SET legal_hold=1,version=version+1 WHERE id='default'");
      if (blocker === 'asset-hold') await f.h.db.run('UPDATE asset_retention SET legal_hold=1,version=version+1 WHERE asset_id=?', a.id);
      if (blocker === 'moderation-hold') await f.h.db.run('INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,?)', holdID, a.id, f.now, 'synthetic retention hold');
      if (blocker === 'request-hold') await f.h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
        VALUES(?,?,?,'delete','pending_approval',?,?,1)`, holdID, f.actor.accountId, f.actor.accountId, f.now, f.now + DAY);
      if (blocker === 'pending-writer') await f.h.db.run(`INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at)
        VALUES(?,?,'QUARANTINE',?,'pending',?)`, writerID, f.actor.accountId, a.key, f.now);
      if (blocker === 'extended-deadline') await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=?,version=version+1 WHERE asset_id=?', f.now + 1000, f.now + 1000, a.id);
      if (blocker === 'source-change') await f.h.db.run('UPDATE assets SET title=? WHERE id=?', 'temporarily changed', a.id);
    } };
    const blocked = await f.schedule(body);
    // A deletion request by this same synthetic operator independently suspends
    // their product authority, so the earlier 401/403 guard wins over deferral.
    if (blocker === 'request-hold') assert([401,403].includes(blocked.status)); else assert.equal(blocked.status, 503);
    assert(inserted);
    assert.equal((await f.command(body)).next_position, 0); assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready');
    assert.equal(await f.journal.lookup(await f.op(a)), null);
    if (blocker === 'global-hold') await f.h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
    if (blocker === 'asset-hold') await f.h.db.run('UPDATE asset_retention SET legal_hold=0,version=version+1 WHERE asset_id=?', a.id);
    if (blocker === 'moderation-hold') await f.h.db.run('UPDATE moderation_holds SET active=0 WHERE id=?', holdID);
    if (blocker === 'request-hold') await f.h.db.run("UPDATE privacy_requests SET legal_hold=0,status='cancelled' WHERE id=?", holdID);
    if (blocker === 'pending-writer') await f.h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", f.now, writerID);
    if (blocker === 'extended-deadline') f.advance(2000);
    if (blocker === 'source-change') await f.h.db.run('UPDATE assets SET title=? WHERE id=?', 'Synthetic fixture', a.id);
    const resumed = await f.schedule(body); assert.equal(resumed.status, 200); assert.deepEqual(resumed.body, { scheduled: true, operation_key: body.operation_key });
    assert.equal((await f.journal.lookup(await f.op(a))).status, 'committed');
  });

test('a policy change before finish returns non-success and the same key resumes after a journalled rebase', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('policy-rebase') }, id = await f.op(a);
  const prepare = f.journal.prepare.bind(f.journal); let armed = false, changed = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === id) armed = true; return value; };
  f.faults.afterCommit = async () => { if (armed && !changed) { changed = true; await f.h.db.run("UPDATE retention_settings SET version=version+1,raw_days=raw_days+1 WHERE id='default'"); } };
  const blocked = await f.schedule(body); assert.equal(blocked.status, 503); assert(changed); assert.equal((await f.command(body)).next_position, 1);
  const resumed = await f.schedule(body); assert.equal(resumed.status, 200); assert.deepEqual(resumed.body, { scheduled: true, operation_key: body.operation_key });
});

test('an unrelated raw conflict remains visible to maintenance but does not block a completed clean command', async t => {
  const f = await setup(t), conflicting = await f.add(80), clean = await f.add(70), body = { limit: 1, operation_key: operation('unrelated-conflict') };
  const job = randomUUID(), object = randomUUID();
  await f.h.db.run("INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at) VALUES(?,?,?,'raw','{}',1,?,'failed',?)", job, f.actor.accountId, conflicting.id, conflicting.version, f.now - DAY);
  await f.h.db.run("INSERT INTO retention_objects(id,job_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)", object, job, conflicting.key, f.now);
  const before = await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', job);
  const result = await f.schedule(body); assert.equal(result.status, 200); assert.equal((await f.journal.lookup(await f.op(clean))).status, 'committed');
  assert.deepEqual(await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', job), before);
  const health = await f.db.invocation(() => runRetention(f.context, 1)); assert(health.failed > 0);
});

test('a completed preview accepts a later same-version raw retirement only with exact independent evidence', async t => {
  const f = await setup(t), preview = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('preview-then-raw') };
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + 1000, f.now - DAY, preview.id);
  const secondID = await f.op(second), prepare = f.journal.prepare.bind(f.journal); let failed = false;
  f.journal.prepare = async (input, ...args) => { if (!failed && input.operation_id === secondID) { failed = true; throw Error('synthetic_second_prepare_not_sent'); } return prepare(input, ...args); };
  assert((await f.schedule(body)).status >= 500); assert(failed); assert.equal((await f.command(body)).next_position, 1);
  await f.h.db.run('UPDATE asset_retention SET legal_hold=1 WHERE asset_id=?', second.id);
  await f.db.invocation(() => runRetention(f.context, 1));
  assert.equal((await f.h.db.one("SELECT status FROM retention_jobs WHERE asset_id=? AND kind='preview'", preview.id)).status, 'verified');
  f.advance(2000); await f.db.invocation(() => runRetention(f.context, 1));
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', preview.id)).status, 'expired');
  assert.equal((await f.journal.lookup(await f.op(preview))).status, 'committed');
  await f.h.db.run('UPDATE asset_retention SET legal_hold=0 WHERE asset_id=?', second.id); f.journal.prepare = prepare;
  const resumed = await f.schedule(body); assert.equal(resumed.status, 200); assert.equal((await f.journal.lookup(secondID)).status, 'committed');
});

test('a malformed legacy-shaped receipt is not returned as a successful schedule', async t => {
  const f = await setup(t), body = { limit: 1, operation_key: operation('malformed-receipt') }, intent = await prepareOperation('retention.schedule', body, 'retention');
  await f.h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    f.actor.accountId, intent.source, intent.key, intent.action, intent.hash, intent.payloadJson, '{}', f.now);
  const result = await f.schedule(body); assert.equal(result.status, 503); assert.equal(result.body.error.code, 'retention_schedule_state_unavailable');
});

test('fresh operator expiry during accepted journal prepare rolls SQL back and leaves the independent fence pending', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('prepare-expiry') };
  const id = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal); let advanced = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (!advanced && input.operation_id === id) { advanced = true; f.advance(301000); } return value; };
  const result = await f.schedule(body); assert.equal(result.status, 503); assert(advanced);
  assert.equal((await f.journal.lookup(id)).status, 'pending'); assert.equal(await f.receipt(body), null);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready');
  f.setOffset(0); assert.equal((await f.schedule(body)).status, 503);
});

test('an acknowledged operator transaction leaves no ephemeral commit guard rows', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('guard-ack') };
  assert.equal((await f.schedule(body)).status, 200);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_schedule_commit_guards')).n, 0);
  assert.equal((await f.journal.lookup(await f.op(a))).status, 'committed');
});

test('the deferred DB-clock guard aborts if fresh authority expires after validation but before COMMIT', { timeout: 30000 }, async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('commit-expiry') };
  const id = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  let injected = false, delayCompleted = false, commitFailures = 0, commitError; f.advance(296000);
  const exec = f.h.engine.exec;
  f.h.engine.exec = async function(sql, ...args) {
    try { return await exec.call(this, sql, ...args); }
    catch (error) { if (sql === 'COMMIT' && delayCompleted) { commitFailures++; commitError = error; } throw error; }
  };
  f.journal.prepare = async (input, ...args) => {
    const value = await prepare(input, ...args);
    if (input.operation_id === id && !injected) f.faults.beforeActualCommit = async connection => {
      injected = true; delete f.faults.beforeActualCommit; await connection.query('SELECT pg_sleep(4.5)', []); delayCompleted = true;
    };
    return value;
  };
  try {
    const result = await f.schedule(body); assert(injected, 'validation must complete before the synthetic delay');
    assert(delayCompleted, 'the synthetic DB-clock delay must finish before COMMIT');
    assert.equal(commitFailures, 1); assert.equal(commitError?.name, 'error');
    assert.equal(commitError?.message, 'retention_schedule_commit_authority_expired'); assert.equal(result.status, 503);
    assert.equal((await f.journal.lookup(id)).status, 'pending'); assert.equal(await f.receipt(body), null);
    assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready');
  } finally { f.h.engine.exec = exec; }
});

test('a locally fabricated raw retirement cannot justify completing a prior preview item', async t => {
  const f = await setup(t), preview = await f.add(80), second = await f.add(70), body = { limit: 2, operation_key: operation('unproved-raw') };
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + 1000, f.now - DAY, preview.id);
  const secondID = await f.op(second), prepare = f.journal.prepare.bind(f.journal); let stopped = false;
  f.journal.prepare = async (input, ...args) => { if (!stopped && input.operation_id === secondID) { stopped = true; throw Error('synthetic_prepare_not_sent'); } return prepare(input, ...args); };
  assert((await f.schedule(body)).status >= 500); assert(stopped);
  await f.h.db.run("UPDATE retention_jobs SET status='verified',verified_at=? WHERE asset_id=? AND kind='preview'", f.now, preview.id);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, preview.id);
  const rawID = await f.op(preview), jobID = await restoreAllocationID(rawID, 'id_0');
  await f.h.db.run(`INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at)
    VALUES(?,?,?,'raw',?,1,?,'pending',?)`, jobID, f.actor.accountId, preview.id,
    stable({object_key:preview.key,checksum:null,retention_version:1,deleted_at:f.now}), preview.version, f.now);
  assert.equal(await f.journal.lookup(rawID), null); f.journal.prepare = prepare;
  const result = await f.schedule(body); assert.equal(result.status, 503);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', second.id)).status, 'ready');
  assert.equal(await f.journal.lookup(secondID), null);
});

for (const phase of ['asset', 'finish']) test(`operator expiry during accepted ${phase} prepare leaves SQL rollback and a pending fence`, async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('expiry-' + phase) };
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), command = await restoreAllocationID(reservation, 'id_0');
  const target = phase === 'asset' ? await f.op(a) : await restoreOperationID(f.actor.accountId, 'retention.schedule.finish-v1', 'retention.finish:' + digest(stable({ command_id: command })));
  const prepare = f.journal.prepare.bind(f.journal); let advanced = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (!advanced && input.operation_id === target) { advanced = true; f.advance(301000); } return value; };
  const result = await f.schedule(body); assert.equal(result.status, 503); assert(advanced); assert.equal((await f.journal.lookup(target)).status, 'pending');
  assert.equal((await f.command(body)).next_position, phase === 'asset' ? 0 : 1);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, phase === 'asset' ? 'ready' : 'expired');
  assert.notEqual((await f.receipt(body)).response_json, stable({ scheduled: true, operation_key: body.operation_key }));
  f.setOffset(0); assert.equal((await f.schedule(body)).status, 503);
});

test('a disabled commit trigger rejects new scheduling before any independent prepare', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('missing-guard') };
  await f.h.engine.exec('ALTER TABLE lovelies_private.retention_schedule_commit_guards DISABLE TRIGGER retention_schedule_commit_guard');
  const id = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), result = await f.schedule(body);
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'retention_schedule_guard_unavailable');
  assert.equal(await f.journal.lookup(id), null); assert.equal(await f.receipt(body), null);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready');
});

test('a replaced source remains deferred while its subject has a hold or unresolved writer', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('replace-held') }, writer = randomUUID();
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal); let armed = false, inserted = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === reservation) armed = true; return value; };
  f.faults.afterCommit = async () => { if (armed && !inserted) {
    inserted = true; await f.h.db.run('UPDATE assets SET version=? WHERE id=?', randomUUID(), a.id);
    await f.h.db.run('UPDATE asset_retention SET legal_hold=1,version=version+1 WHERE asset_id=?', a.id);
    await f.h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)", writer, f.actor.accountId, a.key, f.now);
  } };
  assert.equal((await f.schedule(body)).status, 503); assert.equal((await f.command(body)).next_position, 0);
  await f.h.db.run('UPDATE asset_retention SET legal_hold=0,version=version+1 WHERE asset_id=?', a.id);
  assert.equal((await f.schedule(body)).status, 503); assert.equal((await f.command(body)).next_position, 0);
  await f.h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", f.now, writer);
  assert.equal((await f.schedule(body)).status, 200); assert(await f.h.env.QUARANTINE.head(a.key));
});

test('a prior-policy preview appearing after reservation cannot yield a successful manual receipt', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('late-old-preview') };
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, a.id);
  await f.h.db.run("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',2,60,60,14,2,30,0,?) ON CONFLICT(id) DO UPDATE SET version=2", f.now);
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  const old = randomUUID(); let armed = false, inserted = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === reservation) armed = true; return value; };
  f.faults.afterCommit = async () => {
    if (armed && !inserted) {
      inserted = true;
      await f.h.db.run(`INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at,error_code)
        VALUES(?,?,?,'preview',?,1,?,'pending',?,'preserved_old_preview')`, old, f.actor.accountId, a.id,
        stable({ object_key: a.key, checksum: null, retention_version: 1, deleted_at: null }), a.version, f.now);
    }
  };
  const result = await f.schedule(body); assert(inserted); assert.equal(result.status, 503);
  const command = await f.command(body); assert(command); assert.equal(command.next_position, 0);
  const previous = await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', old); assert.equal(previous.policy_version, 1); assert.equal(previous.status, 'pending');
  assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_jobs WHERE asset_id=?', a.id)).n, 1);
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', a.id)).status, 'ready');
  const stepKey = 'retention.step:' + digest(stable({ command_id: command.id, position: 0 }));
  const step = await restoreOperationID(f.actor.accountId, 'retention.schedule.step-v1', stepKey);
  assert.equal(await f.journal.lookup(step), null); assert.equal((await f.schedule(body)).status, 503);
  assert.deepEqual(await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', old), previous);
});

test('a new preview key after a manual raw reservation cannot produce a successful receipt', async t => {
  const f = await setup(t), a = await f.add(80), body = { limit: 1, operation_key: operation('late-preview-inventory') };
  await f.h.db.run("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',2,60,60,14,2,30,0,?) ON CONFLICT(id) DO UPDATE SET version=2", f.now);
  const preview = randomUUID();
  await f.h.db.run(`INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at,verified_at)
    VALUES(?,?,?,'preview',?,1,?,'verified',?,?)`, preview, f.actor.accountId, a.id,
    stable({object_key:a.key,checksum:null,retention_version:1,deleted_at:null}), a.version, f.now - DAY, f.now - DAY);
  const previous = await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', preview), beforeAsset = await f.h.db.one('SELECT * FROM assets WHERE id=?', a.id);
  const reservation = await restoreOperationID(f.actor.accountId, 'retention', body.operation_key), prepare = f.journal.prepare.bind(f.journal);
  const key = `synthetic/${f.actor.accountId}/preview/${randomUUID()}`, rendition = randomUUID(); let armed = false, inserted = false;
  f.journal.prepare = async (input, ...args) => { const value = await prepare(input, ...args); if (input.operation_id === reservation) armed = true; return value; };
  f.faults.afterCommit = async () => {
    if (armed && !inserted) {
      delete f.faults.afterCommit; inserted = true;
      await f.h.db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status)
        VALUES(?,?,?,'image/png',3,?,?,?,'ready')`, rendition, a.id, key, 'a'.repeat(64), 'b'.repeat(64), randomUUID());
      await f.h.env.PHOTOS.put(key, new Uint8Array([1, 2, 3]));
    }
  };
  const result = await f.schedule(body); assert(inserted); assert.equal(result.status, 503);
  const command = await f.command(body); assert(command); assert.equal(command.next_position, 0);
  assert.deepEqual(await f.h.db.one('SELECT * FROM retention_jobs WHERE id=?', preview), previous);
  assert.deepEqual(await f.h.db.one('SELECT * FROM assets WHERE id=?', a.id), beforeAsset);
  assert.equal((await f.h.db.one('SELECT status FROM renditions WHERE id=?', rendition)).status, 'ready');
  assert(await f.h.env.PHOTOS.head(key)); assert(await f.h.env.QUARANTINE.head(a.key));
  assert.equal(await f.journal.lookup(await f.op(a)), null); assert.equal((await f.schedule(body)).status, 503);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM retention_jobs WHERE asset_id=?', a.id)).n, 1);
});
