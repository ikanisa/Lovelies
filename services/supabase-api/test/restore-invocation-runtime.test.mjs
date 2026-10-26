import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { RestoreJournalClient, RESTORE_PROJECT_ID } from '../src/restore-journal.ts';
import { createApp, createHandler } from '../src/index.ts';
import { PostgresJobQueue, drainJobs } from '../src/jobs.ts';
import { ApiError } from '../src/types.ts';
import { handleOperationRequest } from '../../restore-journal/src/operations.mjs';
import { MemoryStorage, env as journalEnv } from '../../restore-journal/test/fixtures.mjs';
import { fixture, databaseConnection, installMarker, unavailable } from './restore-database-fixture.mjs';
import { enroll, faceVerifierFixture, fixturePng } from './runtime-harness.mjs';

const key = prefix => prefix + '-' + randomUUID();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const waitForBarrier = (barrier, operation) => Promise.race([barrier, operation.then(() => {
  throw Error('Owned operation completed before the expected fixture barrier');
})]);
function processed(envelope) {
  return { attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256,
    model_version: envelope.model_version, engine_identity: envelope.engine_identity,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'), content_type: 'image/png', width: 1, height: 1 },
    matches: [] };
}

/** This fixture models a future independently verified recovery generation.
 * Production has no clear/reset/reopen endpoint: a new controlled in-memory
 * journal and explicit fixture marker installation are not recovery clearance. */
async function nextVerifiedFixtureGeneration(databaseID) {
  const storage = new MemoryStorage(); let tick = 50_000;
  const fetcher = (url, init) => handleOperationRequest(new Request(url, init), journalEnv, storage, { now: () => ++tick });
  const bootstrap = await fetcher('https://journal.invalid/v1/control/bootstrap', {
    method: 'POST', headers: { authorization: 'Bearer ' + journalEnv.RESTORE_JOURNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, project_id: RESTORE_PROJECT_ID, database_id: databaseID, bootstrap_id: randomUUID() }),
  });
  assert.equal(bootstrap.status, 200);
  const value = await bootstrap.json();
  return { marker: value.binding.initial_marker,
    journal: new RestoreJournalClient('https://journal.invalid', journalEnv.RESTORE_JOURNAL_TOKEN, { fetcher }) };
}

async function invocationFixture(t) {
  const clients = [], releases = [], pending = new Set(); let baseCleanup;
  // One owner closes every added native client before the base fixture drops
  // its disposable database. Independent t.after hooks run in registration
  // order, so registering extra closes after fixture(t) is too late.
  t.after(async () => {
    const errors = [];
    try {
      for (const release of releases) try { await release(); } catch (error) { errors.push(error); }
      for (const result of await Promise.allSettled([...pending])) if (result.status === 'rejected') errors.push(result.reason);
    } catch (error) { errors.push(error); }
    finally {
      for (const client of clients.toReversed()) try { await client.close(); } catch (error) { errors.push(error); }
      try { await baseCleanup?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Invocation fixture cleanup failed');
  });
  const f = await fixture({ after: callback => { assert.equal(baseCleanup, undefined); baseCleanup = callback; } });
  const trace = [], faults = {};
  const ownConnection = client => { clients.push(client); return client; };
  const track = operation => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  let live = f.journal;
  const journal = Object.fromEntries(['control', 'admission', 'prepare', 'lookup', 'acknowledge']
    .map(name => [name, (...args) => live[name](...args)]));
  const fence = new RestoreDatabaseFence(journal);
  const db = ownConnection(new PostgresDatabase(databaseConnection(f.h, trace, faults), fence));
  const rotate = async () => {
    const next = await nextVerifiedFixtureGeneration(f.marker.database_id);
    // No business row is rewritten: only this explicitly controlled test port
    // and its fixture marker move to the modeled verified generation.
    await installMarker(f.h, next.marker);
    live = next.journal;
    return next.marker;
  };
  const context = () => createApp(db, f.h.env, f.h.app.now);
  const request = (path, options = {}, app = context()) => {
    const { token, body, method = body === undefined ? 'GET' : 'POST', origin } = options;
    return track(createHandler(app)(new Request('https://api.invalid' + path, { method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })));
  };
  return { ...f, db, fence, journal, trace, faults, rotate, context, request, ownConnection, track,
    onCleanup: callback => releases.push(callback) };
}

async function photoFixture(t, { finish = true } = {}) {
  const f = await invocationFixture(t), h = f.h;
  // Construct the declared baseline with the ordinary fixture database. The
  // request/job under test uses freshly bound createApp closures and fenced db.
  h.env.PHOTO_JOBS = new PostgresJobQueue(h.db);
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const owner = await enroll(h);
  await h.json('/me/photo-preferences', { token: owner.token, body: { receive_matches: true,
    photo_matching_consent: true, processing_consent: true, policy_version: 'photo-policy-fixture-v1', operation_key: key('preferences') } });
  h.env.PHOTO_PROCESSOR = { fetch: async request => Response.json(processed(await request.json())) };
  const bytes = fixturePng(randomUUID());
  const photo = await h.json('/uploads/session', { token: owner.token, body: { source: 'personal',
    content_type: 'image/png', byte_size: bytes.length, title: 'Synthetic invocation fixture',
    upload_batch_id: randomUUID(), operation_key: key('upload') } }, 201);
  await h.json(photo.upload_url, { token: owner.token, method: 'PUT', raw: bytes, headers: { 'content-type': 'image/png' } });
  await h.json(photo.complete_url, { token: owner.token, body: { operation_key: key('complete') } }, 202);
  if (finish) {
    await drainJobs(h.app);
    assert.equal((await h.json('/uploads/' + photo.asset_id + '/status', { token: owner.token })).status, 'ready');
  }
  h.env.PHOTO_JOBS = new PostgresJobQueue(f.db);
  return { ...f, owner, photo, path: '/community/media/' + photo.asset_id + '/preview' };
}

function holdFirstPreview(f) {
  const entered = deferred(), released = deferred(), original = f.h.env.PHOTOS.get.bind(f.h.env.PHOTOS);
  f.onCleanup(released.resolve);
  let armed = true, heldBytes;
  f.h.env.PHOTOS.get = async name => {
    const object = await original(name);
    if (!object || !armed) return object;
    armed = false;
    return { ...object, arrayBuffer: async () => {
      const value = await object.arrayBuffer(); heldBytes = new Uint8Array(value);
      entered.resolve(); await released.promise; return value;
    } };
  };
  return { entered: entered.promise, release: released.resolve, bytes: () => heldBytes };
}

test('verified lineage comes only from this fence admission and its immutable IDs exclude checkpoint revisions', async t => {
  const f = await invocationFixture(t);
  assert.throws(() => f.fence.lineage({ marker: f.marker }), unavailable);
  const raw = f.ownConnection(databaseConnection(f.h, [], {}));
  await raw.begin(async connection => {
    await connection.query('SET TRANSACTION READ ONLY', []);
    await connection.query('SELECT pg_advisory_xact_lock(704536419730718193::bigint)', []);
    await connection.query('SET LOCAL ROLE lovelies_api', []);
    await connection.query('SET LOCAL search_path TO lovelies_private, pg_catalog', []);
    const admission = await f.fence.enter(connection), lineage = f.fence.lineage(admission);
    assert.equal(Object.isFrozen(lineage), true);
    assert.deepEqual(lineage, { database_id: f.marker.database_id, incarnation_id: f.marker.incarnation_id });
    admission.marker = { ...f.marker, incarnation_id: randomUUID() };
    assert.deepEqual(f.fence.lineage(admission), lineage, 'A returned opaque object cannot replace the independently verified lineage snapshot');
  });
});

test('nested invocation joins its first lineage and caught mismatch remains poisoned before SQL or callback work', async t => {
  const f = await invocationFixture(t); let callbacks = 0;
  await assert.rejects(() => f.db.invocation(async () => {
    await f.db.one('SELECT count(*) AS n FROM accounts');
    await f.rotate();
    await assert.rejects(() => f.db.invocation(async () => { callbacks++; await f.db.one('SELECT count(*) AS n FROM accounts'); }), unavailable);
    const before = f.trace.length;
    await assert.rejects(() => f.db.invocation(() => { callbacks++; }), unavailable);
    await assert.rejects(() => f.db.run('INSERT INTO accounts(id,name,created_at) VALUES(?,?,?)', randomUUID(), 'must not write', 1), unavailable);
    assert.equal(f.trace.length, before);
  }), unavailable);
  assert.equal(callbacks, 1); assert.equal((await f.h.db.one('SELECT count(*) AS n FROM accounts')).n, 0);
  assert.equal(await f.db.invocation(async () => (await f.db.one('SELECT count(*) AS n FROM accounts')).n), 0);
});

test('closed invocations reject escaped asynchronous callbacks and cannot begin inside a pre-admitted SQL transaction', async t => {
  const f = await invocationFixture(t), release = deferred(); let escaped;
  f.onCleanup(release.resolve);
  await f.db.invocation(async () => {
    await f.db.one('SELECT count(*) AS n FROM accounts');
    escaped = f.track(release.promise.then(() => f.db.invocation(() => f.db.one('SELECT count(*) AS n FROM accounts'))));
    void escaped.catch(() => {});
  });
  const before = f.trace.length; release.resolve();
  await assert.rejects(escaped, unavailable); assert.equal(f.trace.length, before);
  await assert.rejects(() => f.db.transaction(() => f.db.invocation(() => {})),
    error => error instanceof ApiError && error.code === 'database_invocation_scope_invalid');
});

test('same-incarnation checkpoint advance while preview bytes await remains authorized', async t => {
  const f = await photoFixture(t), held = holdFirstPreview(f);
  const pending = f.request(f.path, { token: f.owner.token }); await waitForBarrier(held.entered, pending);
  await f.db.transaction(() => {});
  held.release(); const response = await pending;
  assert.equal(response.status, 200); assert((await response.arrayBuffer()).byteLength > 0);
});

test('old and fresh concurrent preview requests keep separate incarnations and old bytes are zeroed without release', async t => {
  const f = await photoFixture(t), held = holdFirstPreview(f);
  const pending = f.request(f.path, { token: f.owner.token }); await waitForBarrier(held.entered, pending);
  await f.rotate();
  const fresh = await f.request(f.path, { token: f.owner.token });
  assert.equal(fresh.status, 200); assert((await fresh.arrayBuffer()).byteLength > 0);
  held.release(); const old = await pending;
  assert.equal(old.status, 503); assert.equal((await old.json()).error.code, 'restore_reconciliation_required');
  assert(held.bytes().every(value => value === 0));
});

test('the final invocation admission cancels an already constructed private response and preserves JSON/CORS errors', async t => {
  const f = await photoFixture(t); let armed = true, cancelled = 0;
  const adapter = Object.fromEntries(['all', 'one', 'run', 'read', 'transaction'].map(name => [name, f.db[name].bind(f.db)]));
  adapter.invocation = callback => f.db.invocation(async () => {
    const value = await callback();
    if (armed && value instanceof Response && value.status === 200 && value.headers.get('content-type') === 'image/png') {
      armed = false;
      const original = value.body.cancel.bind(value.body);
      value.body.cancel = reason => { cancelled++; return original(reason); };
      await f.rotate();
    }
    return value;
  });
  const app = createApp(adapter, f.h.env, f.h.app.now), origin = 'http://127.0.0.1:8765';
  const response = await f.request(f.path, { token: f.owner.token, origin }, app);
  assert.equal(response.status, 503); assert.equal(cancelled, 1);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal((await response.json()).error.code, 'restore_reconciliation_required');
});

test('ready cannot return an old 200 after awaited readiness and public preflight never invents database admission', async t => {
  const f = await invocationFixture(t), entered = deferred(), released = deferred(); let armed = true;
  f.onCleanup(released.resolve);
  f.h.env.FACE_AUTH_VERIFIER = { fetch: async () => Response.json({}) };
  f.h.env.PHOTO_PROCESSOR = { fetch: async () => Response.json({}) };
  f.h.env.MODEL_SERVICE_READINESS = async () => { if (armed) { armed = false; entered.resolve(); await released.promise; } return true; };
  const pending = f.request('/ready'); await waitForBarrier(entered.promise, pending);
  await f.rotate(); released.resolve();
  const old = await pending; assert.equal(old.status, 503);
  assert.equal((await old.json()).error.code, 'restore_reconciliation_required');
  assert.equal((await f.request('/ready')).status, 200);
  const before = f.trace.length;
  const preflight = await f.request('/ready', { method: 'OPTIONS', origin: 'http://127.0.0.1:8765' });
  assert.equal(preflight.status, 204); assert.equal(f.trace.length, before);
});

test('a claimed job cannot publish, acknowledge or write failure state in a new incarnation after held inference', async t => {
  const f = await photoFixture(t, { finish: false }), entered = deferred(), released = deferred();
  f.onCleanup(released.resolve);
  f.h.env.PHOTO_PROCESSOR = { fetch: async request => {
    const envelope = await request.json(); entered.resolve(); await released.promise;
    return Response.json(processed(envelope));
  } };
  const pending = f.track(drainJobs(f.context(), 1)); void pending.catch(() => {}); await waitForBarrier(entered.promise, pending);
  const job = await f.h.db.one("SELECT id,state,lease_token FROM job_queue WHERE category='photo'");
  assert.equal(job.state, 'processing'); assert(job.lease_token);
  await f.rotate(); const afterRestore = f.trace.length; released.resolve();
  await assert.rejects(pending, unavailable);
  const saved = await f.h.db.one('SELECT state,lease_token FROM job_queue WHERE id=?', job.id);
  assert.deepEqual(saved, { state: 'processing', lease_token: job.lease_token });
  assert.equal((await f.h.db.one('SELECT count(*) AS n FROM renditions')).n, 0);
  assert.equal((await f.h.db.one('SELECT count(*) AS n FROM candidates')).n, 0);
  assert.equal((await f.h.db.one('SELECT status FROM processing_attempts WHERE asset_id=?', f.photo.asset_id)).status, 'running');
  const mutations = f.trace.slice(afterRestore).filter(entry => entry.kind === 'sql' && /^(UPDATE|INSERT|DELETE) /i.test(entry.sql));
  assert.equal(mutations.length, 0);
});
