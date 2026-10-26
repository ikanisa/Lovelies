import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { PostgresJobQueue, drainJobs } from '../src/jobs.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, faceVerifierFixture, fixturePng } from './runtime-harness.mjs';
import { fixture, controlRow, installMarker, unavailable } from './restore-database-fixture.mjs';

const key = label => label + '-' + randomUUID();
function processor(envelope, recipientID) {
  return { attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256,
    model_version: envelope.model_version, engine_identity: envelope.engine_identity,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'), content_type: 'image/png', width: 1, height: 1 },
    matches: envelope.profiles.filter(profile => profile.account_id === recipientID).map(profile => ({
      recipient_id: profile.account_id, profile_id: profile.profile_id, profile_version: profile.revision, model_version: profile.model_id })) };
}
async function sharingFixture(t, { requested = false, second = false } = {}) {
  const f = await fixture(t), h = f.h;
  // Explicit synthetic baseline construction uses the ordinary fixture database.
  // Guarded request handling below recreates its closures around the fenced DB.
  h.env.PHOTO_JOBS = new PostgresJobQueue(h.db);
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const owner = await enroll(h), recipient = await enroll(h);
  for (const person of [owner, recipient]) await h.json('/me/photo-preferences', { token: person.token, body: {
    receive_matches: true, photo_matching_consent: true, processing_consent: true,
    policy_version: 'photo-policy-fixture-v1', operation_key: key('preferences') } });
  h.env.PHOTO_PROCESSOR = { fetch: async request => Response.json(processor(await request.json(), recipient.accountId)) };
  const bytes = fixturePng(randomUUID());
  const photo = await h.json('/uploads/session', { token: owner.token, body: { content_type: 'image/png',
    byte_size: bytes.byteLength, source: 'personal', title: 'Controlled restore sharing fixture',
    upload_batch_id: randomUUID(), operation_key: key('upload') } }, 201);
  await h.json(photo.upload_url, { token: owner.token, raw: bytes, method: 'PUT', headers: { 'content-type': 'image/png' } });
  await h.json(photo.complete_url, { token: owner.token, body: { operation_key: key('complete') } }, 202);
  await drainJobs(h.app);
  assert.equal((await h.json('/uploads/' + photo.asset_id + '/status', { token: owner.token })).status, 'ready');
  async function makeRequest(accept = true) {
    const snapshot = (await h.community(owner.token, 'sharing.snapshot', { asset_ids: [photo.asset_id], operation_key: key('snapshot') })).snapshot;
    const preview = (await h.community(owner.token, 'sharing.preview', { snapshot_id: snapshot.id, snapshot_version: snapshot.version,
      draft_version: 1, selected_asset_ids: [photo.asset_id], selected_recipient_ids: [recipient.accountId],
      excluded_pairs: [], operation_key: key('preview') })).preview;
    const committed = await h.community(owner.token, 'sharing.commit', { preview_id: preview.id, preview_version: preview.version,
      draft_version: 1, operation_key: key('commit') });
    const id = committed.recipients[0].request_id;
    if (accept) await h.community(recipient.token, 'request.decide', { request_id: id, decision: 'accept', operation_key: key('accept') });
    return id;
  }
  const requestID = await makeRequest(!requested), otherRequestID = second ? await makeRequest(true) : null;
  h.env.PHOTO_JOBS = f.queue;
  const handler = createHandler(createApp(f.db, h.env, h.app.now));
  const request = (path, { token = owner.token, body, method = body === undefined ? 'GET' : 'POST' } = {}) =>
    handler(new Request('https://api.invalid' + path, { method, headers: { authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const decide = async (payload, token = owner.token, expected = 200) => {
    const response = await request('/community/action', { token, body: { action: 'request.decide', payload } });
    const result = await response.json();
    assert.equal(response.status, expected, result?.error?.code ?? result?.status ?? 'unexpected_response');
    return result;
  };
  const payload = (decision = 'revoke') => ({ request_id: requestID, decision, operation_key: key('sharing-retirement') });
  return { ...f, owner, recipient, photo, requestID, otherRequestID, request, decide, payload };
}
const grants = f => f.h.db.all('SELECT request_id,active,revoked_at FROM media_grants ORDER BY request_id');
const requestStatus = async f => (await f.h.db.one('SELECT status FROM sharing_requests WHERE id=?', f.requestID)).status;
const planFor = async (f, payload, actor = f.owner) => f.journal.lookup(await restoreOperationID(actor.accountId, 'personal', payload.operation_key));
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const targetEvent = f => ({ sender_id: f.owner.accountId, recipient_id: f.recipient.accountId, request_id: f.requestID });

for (const decision of ['decline', 'withdraw', 'revoke']) test(`actual sharing ${decision} commits one exact independent retirement and never widens the affected request`, async t => {
  const f = await sharingFixture(t, { requested: decision !== 'revoke', second: decision === 'revoke' });
  const payload = f.payload(decision), actor = decision === 'decline' ? f.recipient : f.owner;
  const result = await f.decide(payload, actor.token);
  assert.equal(result.status, ({ decline: 'declined', withdraw: 'withdrawn', revoke: 'revoked' })[decision]);
  const operation = await planFor(f, payload, actor);
  assert.equal(operation.status, 'committed'); assert.deepEqual(operation.plan.allocations, {});
  assert.equal(operation.plan.events.length, 1); assert.equal(operation.plan.events[0].kind, 'sharing-request-retired');
  assert.deepEqual(operation.plan.events[0].scope, targetEvent(f)); assert.equal(await cursor(f), 1);
  if (decision === 'revoke') {
    const rows = await grants(f);
    assert.equal(rows.find(row => row.request_id === f.requestID).active, 0);
    assert.equal(rows.find(row => row.request_id === f.otherRequestID).active, 1);
  }
  assert.deepEqual(await f.decide(payload, actor.token), result); assert.equal(await cursor(f), 1);
  assert.equal((await f.decide({ ...payload, operation_key: key('already-terminal') }, actor.token)).status, result.status);
  assert.equal(await cursor(f), 1);
  await f.decide({ ...payload, decision: 'accept' }, actor.token, 409);
  assert.equal(await cursor(f), 1);
});

test('acceptance, unauthorized role and invalid transitions create no restriction; a valid accept still grants only the reviewed pair', async t => {
  const f = await sharingFixture(t, { requested: true });
  await f.decide(f.payload('decline'), f.owner.token, 403);
  await f.decide(f.payload('withdraw'), f.recipient.token, 403);
  await f.decide(f.payload('revoke'), f.owner.token, 409);
  assert.equal(await cursor(f), 0); assert.equal((await grants(f)).length, 0);
  const payload = f.payload('accept');
  assert.equal((await f.decide(payload, f.recipient.token)).status, 'accepted');
  const operation = await planFor(f, payload, f.recipient);
  assert.equal(operation.plan.events.length, 0); assert.equal(await cursor(f), 0);
  const rows = await grants(f); assert.equal(rows.length, 1); assert.equal(rows[0].request_id, f.requestID); assert.equal(rows[0].active, 1);
  await f.decide(payload, f.recipient.token); assert.equal((await grants(f)).length, 1); assert.equal(await cursor(f), 0);
});

for (const stage of ['before', 'after']) test(`targeted prepare reply loss ${stage} delivery rolls back sharing SQL and preserves only actually appended restriction facts`, async t => {
  const f = await sharingFixture(t), payload = f.payload(), id = await restoreOperationID(f.owner.accountId, 'personal', payload.operation_key);
  const prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => {
    if (armed && value.operation_id === id) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage }; }
    return prepare(value);
  };
  await f.decide(payload, f.owner.token, 503);
  assert.equal(await requestStatus(f), 'accepted'); assert.equal((await grants(f))[0].active, 1);
  const saved = await f.journal.lookup(id);
  if (stage === 'before') {
    assert.equal(saved, null); assert.equal((await f.journal.control()).state, 'serving');
    await f.decide(payload); assert.equal(await requestStatus(f), 'revoked'); assert.equal(await cursor(f), 1);
  } else {
    assert.equal(saved.status, 'pending'); assert.deepEqual(saved.plan.events[0].scope, targetEvent(f));
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.decide(payload, f.owner.token, 503); assert.equal((await f.journal.lookup(id)).plan.events.length, 1);
    assert.equal(f.trace.filter(value => value.kind === 'sql' && value.sql.startsWith('UPDATE sharing_requests SET status=')).length, 1);
  }
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test(`sharing ${mode} result loss reconciles its exact committed marker and original SQL receipt without another retirement`, async t => {
  const f = await sharingFixture(t), payload = f.payload(), id = await restoreOperationID(f.owner.accountId, 'personal', payload.operation_key);
  if (mode === 'commit') {
    const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => { const result = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true; } return result; };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode === 'ack-before' ? 'before' : 'after' };
  await f.decide(payload, f.owner.token, mode === 'commit' ? 500 : 503);
  assert.equal(await requestStatus(f), 'revoked'); assert.equal((await grants(f))[0].active, 0);
  assert.equal((await f.decide(payload)).status, 'revoked');
  const operation = await f.journal.lookup(id);
  assert.equal(operation.status, 'committed'); assert.equal(operation.plan.events.length, 1); assert.equal(await cursor(f), 1);
  assert.equal(f.trace.filter(value => value.kind === 'sql' && value.sql.startsWith('UPDATE sharing_requests SET status=')).length, 1);
});

test('restored accepted grant rows and their earlier checkpoint quarantine before any private media byte is read', async t => {
  const f = await sharingFixture(t), before = await controlRow(f.h);
  const url = '/community/media/' + f.photo.asset_id + '/preview';
  const available = await f.request(url, { token: f.recipient.token });
  assert.equal(available.status, 200); assert((await available.arrayBuffer()).byteLength > 0);
  await f.decide(f.payload());
  await f.h.db.transaction(async () => {
    await f.h.db.run("UPDATE sharing_requests SET status='accepted' WHERE id=?", f.requestID);
    await f.h.db.run('UPDATE media_grants SET active=1,revoked_at=NULL WHERE request_id=?', f.requestID);
  });
  await installMarker(f.h, { database_id: before.database_id, incarnation_id: before.incarnation_id,
    checkpoint: { revision: before.checkpoint_revision, hash: before.checkpoint_hash },
    cursor: { sequence: before.journal_sequence, hash: before.journal_hash } }, before.last_operation_id, before.last_plan_hash);
  let gets = 0;
  f.h.env.PHOTOS.get = async () => { gets++; throw Error('restored authority must not release bytes'); };
  const response = await f.request(url, { token: f.recipient.token });
  assert.equal(response.status, 503); assert.equal(gets, 0);
  assert.equal((await f.journal.control()).state, 'quarantined');
  assert.equal(await requestStatus(f), 'accepted'); assert.equal((await grants(f))[0].active, 1);
});
