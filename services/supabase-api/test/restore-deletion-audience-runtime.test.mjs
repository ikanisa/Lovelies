import {planEvents} from './restore-plan-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreAllocationID, restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, unavailable } from './restore-database-fixture.mjs';

// This suite uses in-process service transports; the test runner controls the
// database fixture and must explicitly select any separate PostgreSQL instance.
globalThis.fetch = async () => { throw new Error('network_disabled_for_fixture'); };
const key = prefix => prefix + '-' + randomUUID();
const statusToken = () => 'lvd_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const ordered = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);

async function administrator(h) {
  const person = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user', 'admin']), person.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, token: credentials.access_token };
}

async function setup(t, { reviewer = false } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const owner = await enroll(h), admin = reviewer ? await administrator(h) : null;
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const request = (path, { body, token = owner.token } = {}) => handler(new Request('https://api.invalid' + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const json = async (path, options, status) => {
    const response = await request(path, options), value = await response.json();
    assert.equal(response.status, status, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const body = () => ({ operation_key: key('deletion-episode'), status_token: statusToken(), reason: 'LOCAL SYNTHETIC ONLY' });
  const create = (value, status = 201) => json('/privacy/account-deletion', { body: value }, status);
  const logical = value => restoreOperationID(owner.accountId, 'privacy', value.operation_key);
  return { ...f, owner, admin, context, request, json, body, create, logical };
}

async function addConsent(f, purpose, status = 'granted') {
  const id = randomUUID(), now = f.h.app.now();
  await f.h.db.run('INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,revoked_at) VALUES(?,?,?,?,?,?,?)',
    id, f.owner.accountId, purpose, 'synthetic-policy-v1', status, now, status === 'revoked' ? now : null);
  return id;
}
async function before(f) {
  const account = f.owner.accountId;
  return {
    audience: await f.h.db.one('SELECT * FROM account_audience WHERE account_id=?', account),
    consents: await f.h.db.all('SELECT * FROM consents WHERE account_id=? ORDER BY id', account),
    profile: await f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', account),
    requests: await f.h.db.all('SELECT id,status FROM privacy_requests WHERE subject_id=? ORDER BY id', account),
  };
}
function expectedFacts(account, snapshot) {
  const facts = snapshot.consents.filter(c => ['face_authentication', 'photo_matching', 'photo_processing'].includes(c.purpose) && c.status === 'granted')
    .map(c => ({ kind: 'consent-withdrawn', scope: { account_id: account, consent_id: c.id, purpose: c.purpose } }));
  if (snapshot.profile?.status === 'active') facts.push({ kind: 'profile-retired', scope: {
    account_id: account, profile_id: snapshot.profile.id, profile_revision: snapshot.profile.revision,
  } });
  return ordered(facts);
}
async function savedPlan(f, value, expected, { committed = true } = {}) {
  const operationID = await f.logical(value), requestID = await restoreAllocationID(operationID, 'id_0');
  const saved = await f.journal.lookup(operationID); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, { id_0: requestID });
  assert.deepEqual((await planEvents(f,saved)).map(({ kind, scope }) => ({ kind, scope })), [
    { kind: 'account-deletion-requested', scope: { account_id: f.owner.accountId, deletion_request_id: requestID } }, ...expected,
  ]);
  assert.equal(new Set((await planEvents(f,saved)).map(event => event.operation_id)).size, expected.length + 1);
  const serialized = JSON.stringify(saved.plan);
  for (const sensitive of [value.status_token, value.reason, 'template_key', 'template_digest', 'access_token', 'public_jwk'])
    assert(!serialized.includes(sensitive));
  return { saved, requestID };
}

test('deletion request records exact old same-subject consent and active-profile episodes, and its stable retry adds none', { timeout: 30000 }, async t => {
  const f = await setup(t);
  await addConsent(f, 'photo_matching'); await addConsent(f, 'photo_processing');
  const revokedID = await addConsent(f, 'photo_matching', 'revoked');
  const otherPurpose = await addConsent(f, 'unrelated_fixture_purpose');
  const snapshot = await before(f), expected = expectedFacts(f.owner.accountId, snapshot), value = f.body();
  assert.equal(expected.length, 4); // three purpose consents and one profile
  const created = await f.create(value), first = await savedPlan(f, value, expected);
  assert.equal(created.privacy_request.id, first.requestID);
  const after = await before(f);
  for (const fact of expected.filter(fact => fact.kind === 'consent-withdrawn'))
    assert.equal(after.consents.find(c => c.id === fact.scope.consent_id).status, 'revoked');
  assert.equal(after.profile.status, 'revoked');
  assert.equal(after.consents.find(c => c.id === revokedID).status, 'revoked');
  assert.equal(after.consents.find(c => c.id === otherPurpose).status, 'granted');
  assert.deepEqual(await f.create(value), created);
  assert.deepEqual((await savedPlan(f, value, expected)).saved, first.saved);
  assert.equal((await f.journal.control()).marker.cursor.sequence, expected.length + 1);
});

for(const extra of [29,30,60])test(`deletion request captures all ${extra+3} request/authority facts`,{timeout:30000},async t=>{
 const f=await setup(t);for(let i=0;i<extra;i++)await addConsent(f,'photo_matching');
 const snapshot=await before(f),expected=expectedFacts(f.owner.accountId,snapshot),value=f.body();assert.equal(expected.length,extra+2);
 const result=await f.create(value),plan=await savedPlan(f,value,expected);
 assert.equal((await planEvents(f,plan.saved)).length,extra+3);assert.equal(result.privacy_request.id,plan.requestID);
});

test('late same-transaction authority change rolls back the request before preparing a journal plan', { timeout: 30000 }, async t => {
  const f = await setup(t), snapshot = await before(f), value = f.body(), transaction = f.db.transaction.bind(f.db);
  let changed = false;
  f.db.transaction = (callback, intent) => transaction(restore => callback(Object.freeze({
    operation: restore.operation,
    restrict: async (kind, scope) => {
      await restore.restrict(kind, scope);
      if (!changed && kind === 'consent-withdrawn') {
        changed = true;
        await f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.h.app.now(), scope.consent_id);
      }
    },
  })), intent);
  const denied = await f.create(value, 409); assert.equal(denied.error.code, 'audience_authority_changed');
  assert(changed); assert.deepEqual(await before(f), snapshot);
  assert.equal(await f.journal.lookup(await f.logical(value)), null);
});

test('lost independent prepare reply recovers exact restrictions without approving erasure or replaying creation', { timeout: 30000 }, async t => {
  const f = await setup(t), snapshot = await before(f), expected = expectedFacts(f.owner.accountId, snapshot), value = f.body();
  const operationID = await f.logical(value), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async input => {
    if (armed && input.operation_id === operationID) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' }; }
    return prepare(input);
  };
  const response = await f.request('/privacy/account-deletion', { body: value });
  assert(response.status >= 500); await response.body?.cancel();
  assert.deepEqual(await before(f), snapshot);
  const pending = await savedPlan(f, value, expected, { committed: false }); assert.equal(pending.saved.status, 'pending');
  await f.db.one('SELECT id FROM accounts LIMIT 1');
  const recovered=await f.journal.lookup(operationID);assert.equal(recovered.status,'recovered');assert.deepEqual(recovered.plan,pending.saved.plan);assert.equal(recovered.plan_hash,pending.saved.plan_hash);
  const after=await before(f);assert.equal(after.requests.length,1);assert.deepEqual(after.requests,[{id:pending.requestID,status:'pending_approval'}]);
  assert.equal(after.profile.status,'revoked');assert(after.consents.every(c=>c.status==='revoked'));
  const retry = await f.request('/privacy/account-deletion', { body: value }); assert.equal(retry.status,401); await retry.body?.cancel();
  assert.equal(await f.h.db.one("SELECT operation_key FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?",f.owner.accountId,value.operation_key),null);
  assert.equal((await before(f)).requests.length,1);
});

test('lost PostgreSQL commit reply reconciles the same request and exact facts without rerunning the producer', { timeout: 30000 }, async t => {
  const f = await setup(t), expected = expectedFacts(f.owner.accountId, await before(f)), value = f.body();
  const run = f.db.run.bind(f.db); let inserts = 0;
  f.db.run = async (sql, ...bindings) => {
    if (sql.startsWith('INSERT INTO privacy_requests(')) inserts++;
    return run(sql, ...bindings);
  };
  const operationID = await f.logical(value), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async input => {
    const saved = await prepare(input);
    if (armed && input.operation_id === operationID) { armed = false; f.faults.commitReply = true; }
    return saved;
  };
  const response = await f.request('/privacy/account-deletion', { body: value });
  assert(response.status >= 500); await response.body?.cancel();
  // The handler's final read-only admission may already reconcile the exact
  // committed marker before returning the error; otherwise the retry does so.
  const pending = await savedPlan(f, value, expected, { committed: false });
  assert(['pending', 'committed'].includes(pending.saved.status));
  const retry = await f.create(value), reconciled = await savedPlan(f, value, expected);
  assert.equal(retry.privacy_request.id, pending.requestID);
  assert.deepEqual(reconciled.saved.plan, pending.saved.plan);
  assert.equal((await before(f)).requests.length, 1);
  assert.equal(inserts, 1);
  assert.equal((await f.journal.control()).marker.cursor.sequence, expected.length + 1);
});

test('independent rejection preserves the earlier exact withdrawal facts without restoring consent', { timeout: 30000 }, async t => {
  const f = await setup(t, { reviewer: true });
  const snapshot = await before(f), expected = expectedFacts(f.owner.accountId, snapshot), value = f.body();
  assert(snapshot.profile&&snapshot.profile.status==='active');assert(await f.h.env.PHOTOS.head(snapshot.profile.template_key));
  const created = await f.create(value), beforeReview = await savedPlan(f, value, expected);
  const reviewBody = { operation_key: key('independent-rejection'), reason: 'LOCAL SYNTHETIC REVIEW' };
  const reviewed = await f.json('/privacy-requests/' + created.privacy_request.id + '/reject', { token: f.admin.token, body: reviewBody }, 200);
  assert.equal(reviewed.privacy_request.status, 'rejected');
  assert.deepEqual((await savedPlan(f, value, expected)).saved, beforeReview.saved);
  const reviewID = await restoreOperationID(f.admin.accountId, 'privacy', reviewBody.operation_key);
  const review = await f.journal.lookup(reviewID); assert(review && review.status === 'committed');
  assert.deepEqual(review.plan.events.map(({ kind, scope }) => ({ kind, scope })), [{ kind: 'account-deletion-reviewed', scope: {
    account_id: f.owner.accountId, deletion_request_id: beforeReview.requestID, reviewer_id: f.admin.accountId, decision: 'rejected',
  } }]);
  const after = await before(f);
  for (const fact of expected.filter(fact => fact.kind === 'consent-withdrawn'))
    assert.equal(after.consents.find(c => c.id === fact.scope.consent_id).status, 'revoked');
  // The independent rejection cannot restore the withdrawn reference. Its
  // synchronous cleanup now verifies the original bytes absent and removes the
  // exact revoked profile, while the original restriction facts remain saved.
  assert.equal(after.profile,null);assert.equal(after.audience.status,'suspended');
  const cleanup=await f.h.db.all(`SELECT c.status,c.verified_at FROM face_profile_retirements r JOIN cleanup_intents c ON c.id=r.cleanup_id
    WHERE r.account_id=? AND r.profile_id=? AND r.profile_revision=? AND r.template_key=?
    AND c.subject_id=? AND c.bucket='PHOTOS' AND c.object_key=r.template_key`,f.owner.accountId,snapshot.profile.id,snapshot.profile.revision,snapshot.profile.template_key,f.owner.accountId);
  assert.equal(cleanup.length,1);assert.equal(cleanup[0].status,'verified');assert(Number.isSafeInteger(cleanup[0].verified_at));
  assert.equal(await f.h.env.PHOTOS.head(snapshot.profile.template_key),null);
});
