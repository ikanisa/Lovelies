import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { processPrivacyJob } from '../src/privacy.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

const key = label => label + '-' + randomUUID();
const statusToken = () => 'lvd_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const erasedID = f => restoreOperationID(f.owner.accountId, 'privacy-erasure-system-v1', 'privacy.erasure.completed:' + f.deletion.id);
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;

async function administrator(h) {
  const person = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user', 'admin']), person.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  assert(credentials.roles.includes('admin'));
  return { ...person, token: credentials.access_token };
}

/** Actual PostgreSQL and the independent journal run through their ordinary
 * adapters. Only private Storage bytes and face comparison use local fixtures. */
async function terminalFixture(t, { registered = false, asset = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const person = registered ? await enroll(h) : await h.anonymous({ adult: true });
  const owner = registered ? person : { ...person, accountId: person.account_id, token: person.access_token };
  const admin = await administrator(h), peer = await h.anonymous({ adult: true });
  await h.json('/admin/retention', { token: admin.token });
  const ownedAsset = asset ? randomUUID() : null, peerAsset = randomUUID();
  const objectKey = asset ? 'private/erasure-source/' + ownedAsset : null, peerKey = 'private/preserved-source/' + peerAsset;
  const insertAsset = (id, account, object, title) => h.db.run('INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, account, 'personal', 'ready', object, 'image/png', 3, randomUUID(), title, h.app.now());
  if (asset) {
    await insertAsset(ownedAsset, owner.accountId, objectKey, 'PRIVATE ERASURE CAPTION');
    await h.env.QUARANTINE.put(objectKey, new Uint8Array([1, 2, 3]));
    await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,updated_at) VALUES(?,?,?,?)',
      ownedAsset, h.app.now() + 86400000, h.app.now() + 86400000, h.app.now());
  }
  await insertAsset(peerAsset, peer.account_id, peerKey, 'Preserved peer caption');
  await h.env.QUARANTINE.put(peerKey, new Uint8Array([4, 5, 6]));
  for (const account of [owner.accountId, peer.account_id])
    await h.db.run('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)', randomUUID(), account, 'invoice', '{"amount":5}', h.app.now());
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const request = (path, { token = admin.token, body, method = body === undefined ? 'GET' : 'POST' } = {}) =>
    handler(new Request('https://api.invalid' + path, { method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const json = async (path, options = {}, expected = 200) => {
    const response = await request(path, options), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const create = async (type = 'delete', actor = owner) => {
    const body = { operation_key: key('terminal-request'), reason: 'PRIVATE DELETION RATIONALE', ...(type === 'delete' ? { status_token: statusToken() } : {}) };
    const value = await json(type === 'delete' ? '/privacy/account-deletion' : '/privacy/export', { token: actor.token, body }, 201);
    return { ...value.privacy_request, body };
  };
  const reviewBody = () => ({ operation_key: key('terminal-review'), reason: 'PRIVATE INDEPENDENT REVIEW RATIONALE' });
  const review = (id, decision = 'approve', body = reviewBody(), expected = 200, token = admin.token) =>
    json('/privacy-requests/' + id + '/' + decision, { token, body }, expected);
  const process = (expected = 200) => json('/privacy-requests/' + result.deletion.id + '/process', { body: {} }, expected);
  const uncertainProcess = async () => {
    const response = await request('/privacy-requests/' + result.deletion.id + '/process', { body: {} });
    assert(response.status >= 500 && response.status <= 599); await response.body?.cancel();
  };
  const result = { ...f, context, owner, admin, peer, ownedAsset, peerAsset, objectKey, peerKey, request, json, create, reviewBody, review, process, uncertainProcess };
  return result;
}

async function queued(t, options) {
  const f = await terminalFixture(t, options); f.deletion = await f.create(); await f.review(f.deletion.id); return f;
}
const requestRow = f => f.h.db.one('SELECT status,execution_token,lease_until,metadata_erased_at,completed_at FROM privacy_requests WHERE id=?', f.deletion.id);
const cleanupRows = f => f.h.db.all('SELECT id,bucket,object_key,status,attempts,verified_at FROM cleanup_intents WHERE request_id=? ORDER BY id', f.deletion.id);
const reviewID = (f, body) => restoreOperationID(f.admin.accountId, 'privacy', body.operation_key);

async function assertErased(f) {
  const saved = await f.journal.lookup(await erasedID(f));
  assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.allocations, {});
  assert.equal(saved.plan.input_hash, digest(stable({ protocol: 'lovelies-privacy-erasure-completed-v1', action: 'privacy.erasure.completed',
    account_id: f.owner.accountId, deletion_request_id: f.deletion.id })));
  assert.equal(saved.plan.events.length, 1); assert.equal(saved.plan.events[0].kind, 'account-erased');
  assert.deepEqual(saved.plan.events[0].scope, { account_id: f.owner.accountId, deletion_request_id: f.deletion.id });
  const text = JSON.stringify(saved.plan);
  for (const secret of [f.objectKey, f.deletion.body.status_token, 'PRIVATE', 'execution_token', 'lease_until', 'completed_at', f.admin.accountId])
    if (secret) assert(!text.includes(secret), 'Terminal journal plan contains private or execution-specific material');
  assert.equal((await requestRow(f)).status, 'completed');
  assert.equal((await f.h.db.one('SELECT count(*) n FROM assets WHERE owner_id=?', f.owner.accountId)).n, 0);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM asset_retention WHERE asset_id=?', f.ownedAsset)).n, 0);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM financial_records WHERE account_id=?', f.owner.accountId)).n, 1);
  assert.equal((await f.h.db.one('SELECT title FROM assets WHERE id=?', f.peerAsset)).title, 'Preserved peer caption');
  assert(await f.h.env.QUARANTINE.head(f.peerKey));
  for (const row of await cleanupRows(f)) { assert.equal(row.status, 'verified'); assert.equal(await f.h.env[row.bucket].head(row.object_key), null); }
  return saved;
}

for (const decision of ['approve', 'reject']) test('delete ' + decision + ' records one exact independent review with ordinary receipt deduplication', async t => {
  const f = await terminalFixture(t), deletion = await f.create(), body = f.reviewBody();
  const before = await cursor(f), result = await f.review(deletion.id, decision, body);
  const saved = await f.journal.lookup(await reviewID(f, body));
  assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.allocations, {}); assert.equal(saved.plan.events.length, 1);
  assert.equal(saved.plan.events[0].kind, 'account-deletion-reviewed');
  assert.deepEqual(saved.plan.events[0].scope, { account_id: f.owner.accountId, deletion_request_id: deletion.id,
    reviewer_id: f.admin.accountId, decision: decision === 'approve' ? 'approved' : 'rejected' });
  assert(!JSON.stringify(saved.plan).includes(body.reason)); assert(!JSON.stringify(saved.plan).includes(deletion.body.status_token));
  assert.deepEqual(await f.review(deletion.id, decision, body), result); assert.equal(await cursor(f), before + 1);
  await f.review(deletion.id, decision === 'approve' ? 'reject' : 'approve', body, 409);
  await f.review(deletion.id, decision, f.reviewBody(), 409); assert.equal(await cursor(f), before + 1);
});

test('exports, self-review, revoked sessions and invalid current roles append no deletion-review fact', async t => {
  const f = await terminalFixture(t, { registered: true }), exported = await f.create('export'), body = f.reviewBody();
  await f.review(exported.id, 'approve', body);
  assert.equal((await f.journal.lookup(await reviewID(f, body))).plan.events.length, 0); assert.equal(await cursor(f), 0);
  const own = await f.create('delete', f.admin), self = f.reviewBody();
  await f.review(own.id, 'approve', self, 403); assert.equal(await f.journal.lookup(await reviewID(f, self)), null);
  const deletion = await f.create(), before = await cursor(f), invalidRole = f.reviewBody();
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', f.admin.accountId);
  const roleResponse = await f.request('/privacy-requests/' + deletion.id + '/approve', { body: invalidRole });
  assert(roleResponse.status === 401 || roleResponse.status === 403); await roleResponse.body?.cancel();
  assert.equal(await f.journal.lookup(await reviewID(f, invalidRole)), null);
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', f.admin.accountId);
  await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.admin.accountId);
  const stale = f.reviewBody(); await f.review(deletion.id, 'approve', stale, 401);
  assert.equal(await f.journal.lookup(await reviewID(f, stale)), null); assert.equal(await cursor(f), before);
});

async function retentionHold(f, active, asset = false) {
  const path = asset ? '/admin/assets/' + f.ownedAsset + '/retention' : '/admin/retention';
  const current = await f.json(path), rule = asset ? current.asset_retention : current.policy;
  await f.json(path, { method: 'PATCH', body: { legal_hold: active, expected_version: rule.version, operation_key: key('retention-hold') } });
}
async function moderationHold(f, asset) {
  const reportID = randomUUID();
  await f.h.db.run('INSERT INTO safety_reports(id,reporter_id,subject_id,asset_id,reason,status,created_at) VALUES(?,?,?,?,?,?,?)',
    reportID, f.owner.accountId, asset ? null : f.owner.accountId, asset ? f.ownedAsset : null, 'PRIVATE REPORT RATIONALE', 'open', f.h.app.now());
  await f.json('/admin/safety/reports/' + reportID + '/resolve', { body: { action: 'hold', expected_revision: 1, reason: 'PRIVATE HOLD RATIONALE', operation_key: key('moderation-hold') } });
  return () => f.json('/admin/safety/reports/' + reportID + '/resolve', { body: { action: 'release', expected_revision: 2,
    reason: 'Qualified independent review permits erasure', operation_key: key('moderation-release') } });
}

for (const kind of ['request', 'global', 'asset', 'subject-moderation', 'asset-moderation'])
  test(kind + ' hold blocks before metadata/bytes are erased and preserves its evidence until qualified release', async t => {
    const f = await queued(t); let release;
    if (kind === 'request') {
      // Explicit synthetic authority state: there is no public request-hold toggle.
      await f.h.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?', f.deletion.id);
      release = () => f.h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?', f.deletion.id);
    } else if (kind === 'global' || kind === 'asset') {
      await retentionHold(f, true, kind === 'asset'); release = () => retentionHold(f, false, kind === 'asset');
    } else release = await moderationHold(f, kind === 'asset-moderation');
    const evidence = await f.h.db.all('SELECT * FROM moderation_holds ORDER BY id');
    const rules = await f.h.db.all('SELECT * FROM asset_retention WHERE asset_id=?', f.ownedAsset);
    assert.equal((await f.process(409)).error.code, 'privacy_legal_hold');
    assert.equal((await requestRow(f)).metadata_erased_at, null);
    assert.equal((await f.h.db.one('SELECT disabled_at FROM accounts WHERE id=?', f.owner.accountId)).disabled_at, null);
    assert.equal((await f.h.db.one('SELECT title FROM assets WHERE id=?', f.ownedAsset)).title, 'PRIVATE ERASURE CAPTION');
    assert(await f.h.env.QUARANTINE.head(f.objectKey));
    assert.deepEqual(await f.h.db.all('SELECT * FROM moderation_holds ORDER BY id'), evidence);
    assert.deepEqual(await f.h.db.all('SELECT * FROM asset_retention WHERE asset_id=?', f.ownedAsset), rules);
    assert.equal(await f.journal.lookup(await erasedID(f)), null);
    await release(); await f.process(); await assertErased(f);
    if (kind === 'subject-moderation') assert.equal((await f.h.db.one('SELECT active FROM moderation_holds WHERE subject_id=?', f.owner.accountId)).active, 0);
  });

test('ordinary completion minimizes tombstones only after absent-object evidence and records a stable erased fact once', async t => {
  const f = await queued(t), before = await cursor(f); let observed = false;
  const remove = f.h.env.QUARANTINE.delete.bind(f.h.env.QUARANTINE);
  f.h.env.QUARANTINE.delete = async object => {
    if (object === f.objectKey) {
      const row = await f.h.db.one('SELECT title,captured_at,status,deleted_at,version,object_key FROM assets WHERE id=?', f.ownedAsset);
      assert.equal(row.title, null); assert.equal(row.captured_at, null); assert.equal(row.status, 'privacy_erasure');
      assert.notEqual(row.deleted_at, null); assert.equal(row.object_key, f.objectKey);
      assert(await f.h.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=?', f.ownedAsset));
      assert.notEqual((await requestRow(f)).metadata_erased_at, null); assert.equal(await f.journal.lookup(await erasedID(f)), null); observed = true;
    }
    return remove(object);
  };
  await f.process(); assert(observed); const saved = await assertErased(f); assert.equal(await cursor(f), before + 1);
  await f.process(); await f.db.invocation(() => processPrivacyJob({ request_id: f.deletion.id }, f.context));
  assert.deepEqual(await f.journal.lookup(await erasedID(f)), saved); assert.equal(await cursor(f), before + 1);
});

for (const stage of ['delete', 'head']) test('a new active subject hold during Storage ' + stage + ' prevents verification/completion and preserves mapping', async t => {
  const f = await queued(t), bucket = f.h.env.QUARANTINE, original = bucket[stage].bind(bucket), holdID = randomUUID(); let armed = true;
  bucket[stage] = async object => {
    const result = await original(object);
    if (armed && object === f.objectKey) {
      armed = false;
      await f.h.db.run('INSERT INTO moderation_holds(id,subject_id,active,reason,created_at) VALUES(?,?,1,?,?)', holdID, f.owner.accountId, 'PRIVATE NEW HOLD', f.h.app.now());
    }
    return result;
  };
  assert.equal((await f.process(409)).error.code, 'privacy_legal_hold');
  const rows = await cleanupRows(f); assert(rows.some(row => row.object_key === f.objectKey && row.status !== 'verified'));
  assert.notEqual((await requestRow(f)).metadata_erased_at, null); assert.notEqual((await requestRow(f)).status, 'completed');
  assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset)); assert(await f.h.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=?', f.ownedAsset));
  assert.equal((await f.h.db.one('SELECT active,reason FROM moderation_holds WHERE id=?', holdID)).active, 1);
  assert.equal(await f.journal.lookup(await erasedID(f)), null);
  // The DELETE may already have been dispatched; this test proves denial of
  // verification/terminal publication, never restoration of those removed bytes.
});

for (const kind of ['global', 'asset', 'moderation']) test(kind + ' hold/release ABA during Storage awaits cannot reuse the old verification authority', async t => {
  const f = await queued(t), bucket = f.h.env.QUARANTINE, head = bucket.head.bind(bucket); let armed = true;
  bucket.head = async object => {
    const result = await head(object);
    if (armed && object === f.objectKey) {
      armed = false;
      if (kind === 'moderation')
        await f.h.db.run('INSERT INTO moderation_holds(id,subject_id,active,reason,created_at,cleared_at) VALUES(?,?,0,?,?,?)',
          randomUUID(), f.owner.accountId, 'Synthetic independently imposed and released hold', f.h.app.now(), f.h.app.now());
      else if (kind === 'global')
        await f.h.db.run("UPDATE retention_settings SET version=version+2,legal_hold=0 WHERE id='default'");
      else await f.h.db.run('UPDATE asset_retention SET version=version+2,legal_hold=0 WHERE asset_id=?', f.ownedAsset);
    }
    return result;
  };
  assert.equal((await f.process(409)).error.code, 'privacy_cleanup_authority_changed');
  assert((await cleanupRows(f)).some(row => row.object_key === f.objectKey && row.status !== 'verified'));
  assert.equal(await f.journal.lookup(await erasedID(f)), null);
  await f.process(); await assertErased(f);
});

test('a process lease taken over during DELETE cannot verify or erase final evidence', async t => {
  const f = await queued(t), bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket), successor = randomUUID(); let armed = true;
  bucket.delete = async object => {
    await remove(object);
    if (armed && object === f.objectKey) {
      armed = false; await f.h.db.run('UPDATE privacy_requests SET execution_token=?,lease_until=? WHERE id=?', successor, f.h.app.now() + 300000, f.deletion.id);
    }
  };
  assert.equal((await f.process(409)).error.code, 'privacy_execution_changed');
  assert.equal((await requestRow(f)).execution_token, successor); assert.equal((await requestRow(f)).status, 'processing');
  assert((await cleanupRows(f)).some(row => row.object_key === f.objectKey && row.status !== 'verified'));
  assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset)); assert.equal(await f.journal.lookup(await erasedID(f)), null);
});

test('a stale DELETE completion cannot regress a successor verified cleanup after final erasure', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let armed = true, stale;
  // Register this hook before the fixture's connection/database cleanup hook.
  t.after(async () => { release.resolve(); await stale; });
  const f = await queued(t), bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket);
  bucket.delete = async object => {
    await remove(object);
    if (armed && object === f.objectKey) { armed = false; entered.resolve(); await release.promise; }
  };
  stale = f.process(409);
  await Promise.race([entered.promise, stale.then(() => { throw Error('Old cleanup did not reach the held DELETE'); })]);
  await f.h.db.run('UPDATE privacy_requests SET lease_until=? WHERE id=?', f.h.app.now() - 1, f.deletion.id);
  await f.process(); await assertErased(f);
  const verified = await cleanupRows(f), before = await cursor(f);
  assert(verified.length > 0); assert(verified.every(row => row.status === 'verified'));
  release.resolve(); await stale;
  assert.deepEqual(await cleanupRows(f), verified);
  assert.equal((await requestRow(f)).status, 'completed'); assert.equal(await cursor(f), before);
  await assertErased(f);
});

test('a remaining private writer or missing metadata-erasure marker cannot publish an erased fact', async t => {
  const f = await queued(t), bucket = f.h.env.QUARANTINE, head = bucket.head.bind(bucket), writer = randomUUID(); let armed = true;
  bucket.head = async object => {
    const result = await head(object);
    if (armed && object === f.objectKey) {
      armed = false;
      await f.h.db.run('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)',
        writer, f.owner.accountId, 'PHOTOS', 'private/unresolved-writer/' + writer, 'pending', f.h.app.now());
    }
    return result;
  };
  const pending = await f.process(); assert.equal(pending.privacy_request.status, 'failed'); assert.equal(pending.writers_remaining, 1);
  assert.equal(await f.journal.lookup(await erasedID(f)), null); assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset));
  await f.h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", f.h.app.now(), writer);
  await f.process(); await assertErased(f);
});

test('verified cleanup cannot reach terminal commit if the metadata-erasure marker changes before final authority', async t => {
  const f = await queued(t), run = f.db.run.bind(f.db); let armed = true;
  f.db.run = async (sql, ...bindings) => {
    await run(sql, ...bindings);
    if (armed && sql.startsWith("UPDATE cleanup_intents SET status='verified'")) {
      armed = false; await run('UPDATE privacy_requests SET metadata_erased_at=NULL WHERE id=?', f.deletion.id);
    }
  };
  assert.equal((await f.process(409)).error.code, 'privacy_erasure_unconfirmed');
  assert.equal(await f.journal.lookup(await erasedID(f)), null); assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset));
});

test('accepted terminal prepare followed by SQL rollback retains the independent pending predecessor and all final evidence', async t => {
  const f = await queued(t), id = await erasedID(f), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => {
    const result = await prepare(value);
    if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; }
    return result;
  };
  await f.uncertainProcess(); const saved = await f.journal.lookup(id);
  assert.equal(saved.status, 'pending'); assert.equal(saved.plan.events[0].kind, 'account-erased');
  assert.notEqual((await requestRow(f)).status, 'completed'); assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset));
  assert(await f.h.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=?', f.ownedAsset));
  await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
  await f.uncertainProcess(); assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['denial', 'prepare-after', 'commit', 'ack-before', 'ack-after'])
  test('terminal ' + mode + ' preserves its actual commit boundary without a second erased fact', async t => {
    const f = await queued(t), id = await erasedID(f), prepare = f.journal.prepare.bind(f.journal); let armed = true, commitBoundary;
    f.journal.prepare = async value => {
      if (armed && value.operation_id === id) {
        armed = false;
        if (mode === 'denial') throw Error('synthetic_terminal_journal_denial');
        if (mode === 'prepare-after') f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
        if (mode === 'commit') {
          f.faults.commitReply = true;
          f.faults.afterCommit = async () => {
            delete f.faults.afterCommit;
            commitBoundary = { journal: (await f.journal.lookup(id)).status, sql: (await requestRow(f)).status };
          };
        }
        if (mode.startsWith('ack-')) f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
      }
      return prepare(value);
    };
    await f.uncertainProcess(); const saved = await f.journal.lookup(id);
    if (mode === 'denial') {
      assert.equal(saved, null); assert.equal((await f.journal.control()).state, 'serving');
      const leased = await requestRow(f);
      assert.equal(leased.status, 'processing'); assert(leased.execution_token); assert(leased.lease_until > f.h.app.now());
      assert(await f.h.db.one('SELECT id FROM assets WHERE id=?', f.ownedAsset));
      assert.equal((await f.process(503)).error.code, 'privacy_execution_in_progress');
      assert.deepEqual(await requestRow(f), leased, 'An active committed lease cannot be cleared by an uncertain invocation');
      const retry = createApp(f.db, f.h.env, () => leased.lease_until + 1);
      await f.db.invocation(() => processPrivacyJob({ request_id: f.deletion.id }, retry));
      await assertErased(f);
    } else if (mode === 'prepare-after') {
      assert.equal(saved.status, 'pending'); assert.notEqual((await requestRow(f)).status, 'completed');
      await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
      await f.uncertainProcess(); assert.deepEqual(await f.journal.lookup(id), saved);
    } else {
      assert.equal((await requestRow(f)).status, 'completed');
      // A lost COMMIT reply is followed by the ordinary token-guarded failure
      // transaction. Its fresh admission reconciles the exact committed marker
      // before observing that completed SQL cannot be marked failed.
      if (mode === 'commit') {
        assert.deepEqual(commitBoundary, { journal: 'pending', sql: 'completed' });
        assert.equal(f.faults.commitReply, false);
      }
      assert.equal(saved.status, mode === 'ack-before' ? 'pending' : 'committed');
      if (mode.startsWith('ack-')) {
        const path = '/v1/operations/' + id + '/acknowledge';
        assert.equal(f.faults.reply, undefined, 'The intended acknowledgement fault was consumed');
        assert(f.trace.some(value => value.kind === 'journal' && value.path === path));
        assert.equal(f.trace.some(value => value.kind === 'journal_ok' && value.path === path), mode === 'ack-after');
      }
      await f.process();
      const committed = await assertErased(f); assert.equal(committed.plan_hash, saved.plan_hash);
      assert.equal(committed.plan.events.length, 1);
    }
  });
