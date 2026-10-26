import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { AUDIENCE_POLICY, maintainAudience } from '../src/audience.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, unavailable } from './restore-database-fixture.mjs';

const PURPOSES = ['face_authentication', 'photo_matching', 'photo_processing'];
const base = () => ({ policy_version: AUDIENCE_POLICY, operation_key: randomUUID() });
const evidence = () => ({ evidence_method: 'independent_live_review', evidence_reference: 'PRIVATE-REVIEW-' + randomUUID() });
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const projection = f => f.h.db.one('SELECT * FROM account_audience WHERE account_id=?', f.child.account_id);
const requestRow = (f, id = f.requestID) => f.h.db.one('SELECT * FROM guardian_requests WHERE id=?', id);
const approvals = (f, id = f.requestID) => f.h.db.all('SELECT * FROM guardian_purpose_approvals WHERE request_id=? ORDER BY id', id);
const consents = f => f.h.db.all('SELECT * FROM consents WHERE account_id=? ORDER BY id', f.child.account_id);
const profile = f => f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.child.account_id);
const ordered = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
const consentFact = (account, consent) => ({ kind: 'consent-withdrawn', scope: { account_id: account, consent_id: consent.id, purpose: consent.purpose } });
const approvalFact = approval => ({ kind: 'guardian-approval-retired', scope: { child_account_id: approval.child_account_id,
  guardian_request_id: approval.request_id, guardian_approval_id: approval.id, purpose: approval.purpose } });
const profileFact = value => ({ kind: 'profile-retired', scope: { account_id: value.account_id, profile_id: value.id, profile_revision: value.revision } });

async function administrator(h) {
  const person = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', person.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const logged = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, token: logged.access_token };
}

/** Ordinary family setup uses the existing canonical routes before attaching
 * the actual independent journal and fenced PostgreSQL connection. */
async function family(t, { approved = true, registered = false, purposes = PURPOSES } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const child = await h.anonymous(), guardian = await administrator(h), reviewer = await administrator(h);
  await h.json('/me/audience', { method: 'PUT', token: child.access_token,
    body: { ...base(), age_band: '13_17', expected_version: 0 } });
  const created = await h.json('/me/guardian-requests', { token: child.access_token,
    body: { ...base(), expected_version: 1 } }, 201);
  const requestID = created.guardian_request.id;
  await h.json('/guardian-requests/' + requestID + '/claim', { token: guardian.token,
    body: { ...base(), expected_revision: 1, relationship_attested: true, purposes } });
  if (approved) await h.json('/admin/guardian-requests/' + requestID + '/review', { token: reviewer.token,
    body: { ...base(), ...evidence(), expected_revision: 2, decision: 'approve', adult_verified: true, parental_responsibility_verified: true } });
  if (registered) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const challenge = await h.json('/auth/face/registration/challenge', { token: child.access_token,
      body: { device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
        consent: { purpose: 'face_authentication', policy_version: 'face-policy-fixture-v1', granted: true } } }, 201);
    const issued = await h.json('/auth/face/registration/complete', { token: child.access_token,
      body: await captureProofs(h, challenge, keys.privateKey, { token: child.access_token }) });
    child.access_token = issued.access_token;
    await h.json('/me/photo-preferences', { token: child.access_token, body: { receive_matches: true,
      photo_matching_consent: true, processing_consent: true, policy_version: 'photo-policy-fixture-v1', operation_key: randomUUID() } });
  }
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const request = (path, { token = child.access_token, body, method = 'POST' } = {}) => handler(new Request('https://api.invalid' + path,
    { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const json = async (path, options, expected = 200) => {
    const response = await request(path, options), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const uncertain = async (path, options) => {
    const response = await request(path, options); assert(response.status >= 500 && response.status <= 599);
    await response.body?.cancel();
  };
  const declareBody = () => ({ ...base(), age_band: '13_17', expected_version: 1 });
  const declare = (body = declareBody(), expected = 200) => json('/me/audience', { method: 'PUT', body }, expected);
  const withdrawalBody = () => ({ operation_key: randomUUID(), expected_revision: approved ? 3 : 2 });
  const withdraw = (body = withdrawalBody(), expected = 200) => json('/guardian-requests/' + requestID + '/withdraw', { body }, expected);
  const adultBody = () => ({ ...base(), ...evidence(), expected_version: 1, adult_verified: true });
  const adult = (body = adultBody(), expected = 200) => json('/admin/audience/' + child.account_id + '/adult-review', { token: reviewer.token, body }, expected);
  return { ...f, context, child, guardian, reviewer, requestID, request, json, uncertain,
    declareBody, declare, withdrawalBody, withdraw, adultBody, adult };
}

async function selectedFacts(f, { authority = true, guardian = true } = {}) {
  const facts = [];
  if (guardian) for (const approval of await approvals(f))
    if (approval.status === 'approved' && approval.revoked_at === null) facts.push(approvalFact(approval));
  if (authority) {
    for (const consent of await consents(f)) if (consent.status === 'granted') facts.push(consentFact(f.child.account_id, consent));
    const active = await profile(f); if (active?.status === 'active') facts.push(profileFact(active));
  }
  return ordered(facts);
}
async function assertPlan(f, actor, source, key, facts, { committed = true } = {}) {
  const id = await restoreOperationID(actor, source, key), saved = await f.journal.lookup(id); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, {});
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), ordered(facts));
  assert.equal(new Set(saved.plan.events.map(value => value.operation_id)).size, facts.length);
  const encoded = JSON.stringify(saved.plan);
  for (const field of ['evidence_reference', 'evidence_method', 'template_key', 'template_digest', 'access_token', 'refresh_token', 'public_jwk'])
    assert(!encoded.includes('"' + field + '"'), 'Facts contain no private evidence, reference or credential material');
  assert(!encoded.includes('PRIVATE-REVIEW-'));
  return saved;
}
const snapshot = async f => ({ audience: await projection(f), request: await requestRow(f), approvals: await approvals(f),
  consents: await consents(f), profile: await profile(f), retirements: await f.h.db.all('SELECT * FROM face_profile_retirements WHERE account_id=? ORDER BY cleanup_id', f.child.account_id) });
async function expire(f) { await f.h.db.run('UPDATE guardian_requests SET expires_at=? WHERE id=?', f.h.app.now() - 1, f.requestID); }
const expiryID = (f, revision = 3) => restoreOperationID(f.child.account_id, 'audience.guardian-expiry-v1', 'guardian.expire:' + f.requestID + ':' + revision);

async function adjacentFutureExpiry(f) {
  const id = randomUUID(), current = await requestRow(f), admitted = await projection(f);
  await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,guardian_account_id,state,child_audience_version,policy_version,
    created_at,expires_at,revision,reviewed_by,reviewed_at,evidence_method,evidence_reference)
    VALUES(?,?,?,'approved',?,?,?,?,3,?,?,?,?)`, id, current.child_account_id, current.guardian_account_id,
    admitted.version + 1, current.policy_version, current.created_at + 1, f.h.app.now() - 1,
    current.reviewed_by, current.reviewed_at, current.evidence_method, current.evidence_reference);
  for (const approval of await approvals(f)) await f.h.db.run(`INSERT INTO guardian_purpose_approvals(id,request_id,child_account_id,
    guardian_account_id,guardian_audience_version,purpose,policy_version,status,version,created_at,expires_at,revoked_at)
    VALUES(?,?,?,?,?,?,?,'approved',?,?,?,?)`, randomUUID(), id, approval.child_account_id, approval.guardian_account_id,
    approval.guardian_audience_version, approval.purpose, approval.policy_version, approval.version,
    approval.created_at, approval.expires_at, approval.revoked_at);
  return { id, request: await requestRow(f, id), approvals: await approvals(f, id) };
}

async function expiredPendingChild(f, createdAt) {
  const child = await f.h.anonymous();
  await f.h.json('/me/audience', { method: 'PUT', token: child.access_token,
    body: { ...base(), age_band: '13_17', expected_version: 0 } });
  const result = await f.h.json('/me/guardian-requests', { token: child.access_token,
    body: { ...base(), expected_version: 1 } }, 201);
  const id = result.guardian_request.id;
  await f.h.db.run('UPDATE guardian_requests SET created_at=?,expires_at=? WHERE id=?', createdAt, f.h.app.now() - 1, id);
  return { child, id };
}

test('a first anonymous declaration creates no invented old-authority facts or profile', async t => {
  const f = await fixture(t), child = await f.h.anonymous(), body = { ...base(), age_band: '13_17', expected_version: 0 };
  const handler = createHandler(createApp(f.db, f.h.env, f.h.app.now));
  const response = await handler(new Request('https://api.invalid/me/audience', { method: 'PUT',
    headers: { authorization: 'Bearer ' + child.access_token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal(response.status, 200); await response.body?.cancel();
  const saved = await f.journal.lookup(await restoreOperationID(child.account_id, 'audience', body.operation_key));
  assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.events, []);
  assert.equal((await f.h.db.one('SELECT status FROM account_audience WHERE account_id=?', child.account_id)).status, 'guardian_pending');
  assert.equal(await f.h.db.one('SELECT id FROM face_profiles WHERE account_id=?', child.account_id), null);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM consents WHERE account_id=?', child.account_id)).n, 0);
});

test('anonymous child redeclaration retires its old approved relationship even without a profile or consent', async t => {
  const f = await family(t), body = f.declareBody(), facts = await selectedFacts(f);
  assert.equal(await profile(f), null); assert.equal((await consents(f)).length, 0); assert.equal(facts.length, 3);
  await f.declare(body); await assertPlan(f, f.child.account_id, 'audience', body.operation_key, facts);
  assert.equal((await projection(f)).version, 2); assert.equal((await projection(f)).status, 'guardian_pending');
  assert.equal((await requestRow(f)).state, 'withdrawn'); assert((await approvals(f)).every(p => p.status === 'revoked'));
  const before = await cursor(f); await f.declare(body); assert.equal(await cursor(f), before);
});

test('registered redeclaration records exact old purposes/profile revision and preserves other accounts', async t => {
  const f = await family(t, { registered: true }), body = f.declareBody(), facts = await selectedFacts(f);
  const guardianProfile = await f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.guardian.accountId);
  const guardianConsents = await f.h.db.all('SELECT * FROM consents WHERE account_id=? ORDER BY id', f.guardian.accountId);
  assert.equal(facts.filter(fact => fact.kind === 'consent-withdrawn').length, 3);
  await f.declare(body); await assertPlan(f, f.child.account_id, 'audience', body.operation_key, facts);
  assert.equal((await profile(f)).status, 'revoked'); assert((await consents(f)).every(consent => consent.status === 'revoked'));
  assert.deepEqual(await f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.guardian.accountId), guardianProfile);
  assert.deepEqual(await f.h.db.all('SELECT * FROM consents WHERE account_id=? ORDER BY id', f.guardian.accountId), guardianConsents);
});

test('requested-only relationships terminate without an invented approval-retirement fact', async t => {
  const f = await family(t, { approved: false }), body = f.withdrawalBody();
  await f.withdraw(body); await assertPlan(f, f.child.account_id, 'guardian', body.operation_key, []);
  assert.equal((await requestRow(f)).state, 'withdrawn'); assert((await approvals(f)).every(p => p.status === 'revoked'));
  assert.equal(await cursor(f), 0);
});

test('guardian withdrawal records exact approved purposes and old profile, while replay returns current authority', async t => {
  const f = await family(t, { registered: true }), body = f.withdrawalBody(), facts = await selectedFacts(f);
  const reply = await f.withdraw(body); assert.equal(reply.guardian_request.state, 'withdrawn');
  const saved = await assertPlan(f, f.child.account_id, 'guardian', body.operation_key, facts);
  await f.withdraw(body);
  assert.deepEqual(await f.journal.lookup(saved.plan.operation_id), saved);
  assert.equal((await projection(f)).status, 'guardian_pending');
  const changed = await f.withdraw({ ...body, expected_revision: 4 }, 409); assert.equal(changed.error.code, 'operation_key_conflict');
});

test('rejection records no never-approved guardian fact and cannot self-review', async t => {
  const f = await family(t, { approved: false }), body = { ...base(), ...evidence(), expected_revision: 2,
    decision: 'reject', adult_verified: false, parental_responsibility_verified: false };
  const path = '/admin/guardian-requests/' + f.requestID + '/review';
  await f.json(path, { token: f.guardian.token, body }, 403);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.guardian.accountId, 'guardian', body.operation_key)), null);
  await f.json(path, { token: f.reviewer.token, body });
  await assertPlan(f, f.reviewer.accountId, 'guardian', body.operation_key, []);
  assert.equal((await requestRow(f)).state, 'rejected');
});

test('independent adulthood review retires old child authority and leaves the reviewed adult eligible', async t => {
  const f = await family(t, { registered: true }), body = f.adultBody(), facts = await selectedFacts(f);
  await f.adult(body); const saved = await assertPlan(f, f.reviewer.accountId, 'audience', body.operation_key, facts);
  const current = await projection(f); assert.equal(current.age_band, '18_plus'); assert.equal(current.status, 'eligible');
  assert.equal((await requestRow(f)).state, 'withdrawn');
  await f.adult(body); assert.deepEqual(await f.journal.lookup(saved.plan.operation_id), saved);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM audience_adult_reviews WHERE account_id=?', f.child.account_id)).n, 1);
});

for (const transition of ['redeclaration', 'adult-review']) test(transition + ' fails closed before any effects when an adjacent future episode exists', async t => {
  const f = await family(t, { registered: true }), future = await adjacentFutureExpiry(f), before = await snapshot(f);
  const body = transition === 'redeclaration' ? f.declareBody() : f.adultBody();
  const response = transition === 'redeclaration' ? await f.declare(body, 409) : await f.adult(body, 409);
  assert.equal(response.error.code, 'audience_future_guardian_episode'); assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await requestRow(f, future.id), future.request); assert.deepEqual(await approvals(f, future.id), future.approvals);
  assert.equal(await f.journal.lookup(await restoreOperationID(transition === 'redeclaration' ? f.child.account_id : f.reviewer.accountId, 'audience', body.operation_key)), null);
  assert.equal(await cursor(f), 0);
});

for (const malformed of ['child', 'guardian']) test('malformed ' + malformed + ' approval ownership fails before relationship or subject mutation', async t => {
  const f = await family(t, { registered: true }), foreign = await f.h.anonymous({ adult: true });
  const selected = (await approvals(f))[0];
  await f.h.db.run('UPDATE guardian_purpose_approvals SET ' + (malformed === 'child' ? 'child_account_id' : 'guardian_account_id') + '=? WHERE id=?', foreign.account_id, selected.id);
  const before = await snapshot(f), body = f.withdrawalBody();
  assert.equal((await f.withdraw(body, 409)).error.code, 'guardian_approval_scope_invalid');
  assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key)), null);
});

test('fresh guardian approval creates no restrictive grant-retirement facts', async t => {
  const f = await family(t, { approved: false }), body = { ...base(), ...evidence(), expected_revision: 2,
    decision: 'approve', adult_verified: true, parental_responsibility_verified: true };
  await f.json('/admin/guardian-requests/' + f.requestID + '/review', { token: f.reviewer.token, body });
  await assertPlan(f, f.reviewer.accountId, 'guardian', body.operation_key, []);
  assert.equal((await projection(f)).status, 'eligible'); assert.equal(await cursor(f), 0);
});

test('expired approved relationship produces exact one-episode system facts and repeated maintenance is a no-op', async t => {
  const f = await family(t, { registered: true }), facts = await selectedFacts(f);
  await expire(f); await f.db.invocation(() => maintainAudience(f.context));
  const id = await expiryID(f), saved = await f.journal.lookup(id); assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), facts);
  assert.deepEqual(saved.plan.allocations, {}); assert.equal((await requestRow(f)).state, 'expired');
  const before = await cursor(f); await f.db.invocation(() => maintainAudience(f.context));
  assert.equal(await cursor(f), before); assert.deepEqual(await f.journal.lookup(id), saved);
});

test('old expiration after independently reviewed adulthood cannot retire a new adult profile or purpose', async t => {
  const f = await family(t), old = await requestRow(f); await f.adult();
  // Preserve an old active row to model delayed same-version maintenance;
  // fresh adult authority is a distinct episode and is not a guardian child.
  await f.h.db.run("UPDATE guardian_requests SET state='approved',revision=?,expires_at=?,terminated_at=NULL WHERE id=?", old.revision, f.h.app.now() - 1, f.requestID);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const challenge = await f.json('/auth/face/registration/challenge', { token: f.child.access_token,
    body: { device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
      consent: { purpose: 'face_authentication', policy_version: 'face-policy-fixture-v1', granted: true } } }, 201);
  await f.json('/auth/face/registration/complete', { token: f.child.access_token,
    body: await captureProofs(f.h, challenge, keys.privateKey, { token: f.child.access_token }) });
  const consent = randomUUID();
  await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
    VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, consent, f.child.account_id, f.h.app.now());
  const audience = await projection(f), before = await f.h.db.one('SELECT * FROM consents WHERE id=?', consent), newProfile = await profile(f);
  await f.db.invocation(() => maintainAudience(f.context));
  assert.equal((await requestRow(f)).state, 'expired'); assert.deepEqual(await projection(f), audience);
  assert.deepEqual(await f.h.db.one('SELECT * FROM consents WHERE id=?', consent), before);
  assert.deepEqual(await profile(f), newProfile);
  const saved = await f.journal.lookup(await expiryID(f)); assert.deepEqual(saved.plan.events, []);
});

test('an old expiry cannot suspend a same-version replacement guardian episode', async t => {
  const f = await family(t), replacement = randomUUID(); await expire(f);
  await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at)
    VALUES(?,?,'pending',1,?,?,?)`, replacement, f.child.account_id, AUDIENCE_POLICY, f.h.app.now() + 1, f.h.app.now() + 86400000);
  const before = await projection(f), facts = await selectedFacts(f, { authority: false });
  await f.db.invocation(() => maintainAudience(f.context));
  const saved = await f.journal.lookup(await expiryID(f));
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), facts);
  assert.equal((await requestRow(f)).state, 'expired');
  assert.equal((await f.h.db.one('SELECT state FROM guardian_requests WHERE id=?', replacement)).state, 'pending');
  assert.deepEqual(await projection(f), before);
});

test('expired-request replacement journals the old approval before inserting a fresh pending request', async t => {
  const f = await family(t), facts = await selectedFacts(f), body = { ...base(), expected_version: 1 }; await expire(f);
  const reply = await f.json('/me/guardian-requests', { body }, 201);
  await assertPlan(f, f.child.account_id, 'guardian', body.operation_key, facts);
  assert.notEqual(reply.guardian_request.id, f.requestID); assert.equal(reply.guardian_request.state, 'pending');
  assert.equal((await requestRow(f)).state, 'expired'); assert.equal((await projection(f)).version, 2);
});

test('expired-request replacement fails closed instead of incrementing into an adjacent future v+1 episode', async t => {
  const f = await family(t, { registered: true }); await expire(f);
  const future = await adjacentFutureExpiry(f), before = await snapshot(f), body = { ...base(), expected_version: 1 };
  const response = await f.json('/me/guardian-requests', { body }, 409);
  assert.equal(response.error.code, 'audience_future_guardian_episode'); assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await requestRow(f, future.id), future.request); assert.deepEqual(await approvals(f, future.id), future.approvals);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key)), null);
  assert.equal(await cursor(f), 0);
});

test('repeated maintenance cannot acquire an adjacent future v+1 episode through a prior expiry', async t => {
  const f = await family(t, { registered: true }); await expire(f);
  const future = await adjacentFutureExpiry(f), before = await snapshot(f);
  for (const blocked of [true, false, true, false]) {
    if (blocked) await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
    else await f.db.invocation(() => maintainAudience(f.context)); // Empty page wraps the owned cursor.
    assert.deepEqual(await snapshot(f), before); assert.equal((await projection(f)).version, 1);
    assert.deepEqual(await requestRow(f, future.id), future.request); assert.deepEqual(await approvals(f, future.id), future.approvals);
    assert.equal(await f.journal.lookup(await expiryID(f)), null);
    assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'audience.guardian-expiry-v1', 'guardian.expire:' + future.id + ':3')), null);
    assert.equal(await cursor(f), 0);
  }
});

for (const newAuthority of ['adult', 'replacement']) test('expiry rechecks new ' + newAuthority + ' authority after admission and before its transaction', async t => {
  const f = await family(t); await expire(f);
  const all = f.db.all.bind(f.db), replacement = randomUUID(), consent = randomUUID(); let admitted = false, current, readDepth = 0;
  f.db.all = async (sql, ...bindings) => {
    const outerRead = readDepth++ === 0;
    let selected;
    try { selected = await all(sql, ...bindings); } finally { readDepth--; }
    // PostgresDatabase.all re-enters this method inside its read transaction.
    // Inject only after the outer read commits so the independent writer can
    // acquire its own transaction gate before the per-request mutation starts.
    if (outerRead && !admitted && sql.startsWith('SELECT r.*,admitted.version admitted_audience_version')) {
      admitted = true;
      // This independent committed change occurs after candidate admission and
      // before the per-request transaction. It must be rechecked inside it.
      if (newAuthority === 'adult') await f.h.db.run("UPDATE account_audience SET age_band='18_plus',status='eligible',version=version+1 WHERE account_id=?", f.child.account_id);
      else await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at)
        VALUES(?,?,'pending',1,?,?,?)`, replacement, f.child.account_id, AUDIENCE_POLICY, f.h.app.now() + 1, f.h.app.now() + 86400000);
      await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
        VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, consent, f.child.account_id, f.h.app.now());
      current = { audience: await projection(f), consent: await f.h.db.one('SELECT * FROM consents WHERE id=?', consent) };
    }
    return selected;
  };
  const facts = await selectedFacts(f, { authority: false });
  await f.db.invocation(() => maintainAudience(f.context)); assert.equal(admitted, true);
  await assertPlan(f, f.child.account_id, 'audience.guardian-expiry-v1', 'guardian.expire:' + f.requestID + ':3', facts);
  assert.equal((await requestRow(f)).state, 'expired'); assert.deepEqual(await projection(f), current.audience);
  assert.deepEqual(await f.h.db.one('SELECT * FROM consents WHERE id=?', consent), current.consent);
  if (newAuthority === 'replacement') assert.equal((await requestRow(f, replacement)).state, 'pending');
});

for (const blockedCause of ['capacity', 'scope']) test('oldest ' + blockedCause + ' denial rolls back and reports while a later independent expiry commits', async t => {
  const f = await family(t, { registered: true }), now = f.h.app.now(); await expire(f);
  await f.h.db.run('UPDATE guardian_requests SET created_at=? WHERE id=?', now - 2000, f.requestID);
  if (blockedCause === 'capacity') {
    const count = (await selectedFacts(f)).length;
    for (let index = count; index < 33; index++) await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
      VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, randomUUID(), f.child.account_id, now);
  } else {
    const foreign = await f.h.anonymous(), selected = (await approvals(f))[0];
    await f.h.db.run('UPDATE guardian_purpose_approvals SET child_account_id=? WHERE id=?', foreign.account_id, selected.id);
  }
  const later = await expiredPendingChild(f, now - 1000), before = await snapshot(f);
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await expiryID(f)), null);
  assert.equal((await requestRow(f, later.id)).state, 'expired');
  assert.equal((await f.h.db.one('SELECT version FROM account_audience WHERE account_id=?', later.child.account_id)).version, 2);
  await assertPlan(f, later.child.account_id, 'audience.guardian-expiry-v1', 'guardian.expire:' + later.id + ':1', []);
});

test('a bounded blocked page advances across invocations to a later independent child without changing any blocked episode', async t => {
  const f = await family(t), now = f.h.app.now(); await expire(f);
  await f.h.db.run('UPDATE guardian_requests SET created_at=? WHERE id=?', now - 3000, f.requestID);
  const future = await adjacentFutureExpiry(f);
  for (let index = 1; index <= 100; index++) {
    const id = randomUUID();
    await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at)
      VALUES(?,?,'pending',1,?,?,?)`, id, f.child.account_id, AUDIENCE_POLICY, now - 3000 + index, now - 1);
  }
  const later = await expiredPendingChild(f, now - 1000), before = await snapshot(f);
  const blockedRows = await f.h.db.all('SELECT * FROM guardian_requests WHERE child_account_id=? ORDER BY id', f.child.account_id);
  const all = f.db.all.bind(f.db), pageSizes = []; let readDepth = 0;
  f.db.all = async (sql, ...bindings) => {
    const outerRead = readDepth++ === 0;
    let result;
    try { result = await all(sql, ...bindings); } finally { readDepth--; }
    if (outerRead && sql.startsWith('SELECT r.*,admitted.version admitted_audience_version')) pageSizes.push(result.length);
    return result;
  };
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
  assert.equal((await requestRow(f, later.id)).state, 'pending'); assert.deepEqual(pageSizes, [100]);
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
  assert.deepEqual(pageSizes, [100, 2]); assert.equal((await requestRow(f, later.id)).state, 'expired');
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await f.h.db.all('SELECT * FROM guardian_requests WHERE child_account_id=? ORDER BY id', f.child.account_id), blockedRows);
  assert.deepEqual(await requestRow(f, future.id), future.request); assert.deepEqual(await approvals(f, future.id), future.approvals);
  assert.equal((await f.h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'")).last_id, later.id);
  await f.db.invocation(() => maintainAudience(f.context)); assert.deepEqual(pageSizes, [100, 2, 0]);
  assert.deepEqual(await f.h.db.one("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'"), { last_at: null, last_id: null });
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
  assert.deepEqual(pageSizes, [100, 2, 0, 100]);
  assert.deepEqual(await snapshot(f), before); assert.equal(await cursor(f), 0);
});

for (const malformedCandidate of ['negative-time', 'legacy-id', 'oversized-time']) test('unsupported ' + malformedCandidate + ' source stays intact while repeated paging processes later independent work', async t => {
  const f = await family(t), now = f.h.app.now(), unsupported = await expiredPendingChild(f, now - 2000);
  let id = unsupported.id;
  if (malformedCandidate === 'legacy-id') {
    id = 'legacy-test-row'; await f.h.db.run('UPDATE guardian_requests SET id=? WHERE id=?', id, unsupported.id);
  } else if (malformedCandidate === 'negative-time') await f.h.db.run('UPDATE guardian_requests SET created_at=-1 WHERE id=?', id);
  else await f.h.db.run('UPDATE guardian_requests SET created_at=9007199254740992 WHERE id=?', id);
  // PostgreSQL text serialization preserves the oversized integer exactly;
  // neither fixture bigint parsing nor JSON number conversion can round it.
  const source = () => f.h.db.one('SELECT row_to_json(r)::text snapshot FROM guardian_requests r WHERE id=?', id);
  const before = await source(), audience = await f.h.db.one('SELECT * FROM account_audience WHERE account_id=?', unsupported.child.account_id);
  const later = await expiredPendingChild(f, now - 1000);
  for (let pass = 0; pass < 3; pass++) {
    await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
    assert.deepEqual(await source(), before);
    assert.deepEqual(await f.h.db.one('SELECT * FROM account_audience WHERE account_id=?', unsupported.child.account_id), audience);
    const stored = await f.h.db.one("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'");
    if (pass === 0) { assert.equal(stored.last_id, later.id); assert(Number.isSafeInteger(stored.last_at)); assert(stored.last_at >= 0); }
    else assert.deepEqual(stored, { last_at: null, last_id: null });
    assert.equal((await requestRow(f, later.id)).state, 'expired');
  }
  const next = await expiredPendingChild(f, now - 500);
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_maintenance_blocked');
  assert.equal((await requestRow(f, next.id)).state, 'expired'); assert.deepEqual(await source(), before);
  assert.equal((await f.h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'")).last_id, next.id);
  assert.equal(await f.journal.lookup(await restoreOperationID(unsupported.child.account_id, 'audience.guardian-expiry-v1', 'guardian.expire:' + id + ':1')), null);
  assert.equal(await cursor(f), 0);
});

test('audience expiry updates only its named cursor and preserves retention class and other owner namespaces', async t => {
  const f = await family(t); await expire(f);
  for (const [scan, entity] of [['guardian', ''], ['guardian', 'other-owner'], ['adult', randomUUID()], ['privacy', 'inactive-profile']])
    await f.h.db.run('INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES(?,?,?,?)', scan, entity, 123, 'unrelated-owner-value');
  const before = await f.h.db.all('SELECT * FROM retention_scan_cursors ORDER BY scan,entity_id');
  await f.db.invocation(() => maintainAudience(f.context));
  assert.deepEqual(await f.h.db.all("SELECT * FROM retention_scan_cursors WHERE NOT(scan='guardian' AND entity_id='audience-expiry-v1') ORDER BY scan,entity_id"), before);
  assert.equal((await f.h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'")).last_id, f.requestID);
});

for (const badCursor of ['unknown-id', 'negative-time']) test('malformed owned expiry cursor ' + badCursor + ' fails closed and preserves its bytes', async t => {
  const f = await family(t); await expire(f);
  await f.h.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('guardian','audience-expiry-v1',?,?)",
    badCursor === 'negative-time' ? -1 : 123, badCursor === 'unknown-id' ? 'unrecognized' : randomUUID());
  const before = await snapshot(f), stored = await f.h.db.all('SELECT * FROM retention_scan_cursors');
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => error.code === 'audience_cursor_invalid');
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.h.db.all('SELECT * FROM retention_scan_cursors'), stored);
  assert.equal(await f.journal.lookup(await expiryID(f)), null); assert.equal(await cursor(f), 0);
});

for (const fatal of ['journal-poison', 'unknown-sql']) test('maintenance ' + fatal + ' stops before later rows and never advances its cursor', async t => {
  const f = await family(t), now = f.h.app.now(); await expire(f);
  await f.h.db.run('UPDATE guardian_requests SET created_at=? WHERE id=?', now - 2000, f.requestID);
  const later = await expiredPendingChild(f, now - 1000), before = await snapshot(f), laterBefore = await requestRow(f, later.id);
  if (fatal === 'journal-poison') f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
  else {
    const run = f.db.run.bind(f.db);
    f.db.run = async (sql, ...bindings) => { if (sql.startsWith('UPDATE guardian_requests SET state=')) throw Error('synthetic_unknown_sql_failure'); return run(sql, ...bindings); };
  }
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), error => fatal === 'journal-poison' ? unavailable(error) : error.message === 'synthetic_unknown_sql_failure');
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await requestRow(f, later.id), laterBefore);
  assert.equal(await f.h.db.one("SELECT * FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'"), null);
  if (fatal === 'journal-poison') { assert.equal(f.faults.reply, undefined); assert.equal((await f.journal.lookup(await expiryID(f))).status, 'pending'); }
  else assert.equal(await f.journal.lookup(await expiryID(f)), null);
});

test('more than32 aggregate expiry facts are committed as separate bounded relationship transactions', async t => {
  const f = await family(t); await expire(f);
  const episodes = [{ account: f.child.account_id, id: f.requestID }];
  // Twelve independent children have three actual approved purpose episodes
  // each. There is no request/version truncation to squeeze36 facts into32.
  for (let index = 0; index < 11; index++) {
    const child = await f.h.anonymous(), id = randomUUID(); episodes.push({ account: child.account_id, id });
    await f.h.json('/me/audience', { method: 'PUT', token: child.access_token,
      body: { ...base(), age_band: '13_17', expected_version: 0 } });
    await f.h.db.run("UPDATE account_audience SET status='eligible' WHERE account_id=?", child.account_id);
    await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,guardian_account_id,state,child_audience_version,policy_version,
      created_at,expires_at,revision,reviewed_by,reviewed_at) VALUES(?,?,?,'approved',1,?,?,?,3,?,?)`,
      id, child.account_id, f.guardian.accountId, AUDIENCE_POLICY, f.h.app.now() - 1000 - index, f.h.app.now() - 1, f.reviewer.accountId, f.h.app.now() - 5000);
    for (const purpose of PURPOSES) await f.h.db.run(`INSERT INTO guardian_purpose_approvals(id,request_id,child_account_id,guardian_account_id,
      guardian_audience_version,purpose,policy_version,status,created_at,expires_at) VALUES(?,?,?,?,1,?,?,'approved',?,?)`,
      randomUUID(), id, child.account_id, f.guardian.accountId, purpose, purpose === 'face_authentication' ? 'face-policy-fixture-v1' : 'photo-policy-fixture-v1', f.h.app.now() - 5000, f.h.app.now() - 1);
  }
  await f.db.invocation(() => maintainAudience(f.context));
  assert.equal(await cursor(f), 36);
  for (const episode of episodes) {
    const saved = await f.journal.lookup(await restoreOperationID(episode.account, 'audience.guardian-expiry-v1', 'guardian.expire:' + episode.id + ':3'));
    assert.equal(saved.status, 'committed'); assert.equal(saved.plan.events.length, 3);
    assert.equal((await f.h.db.one('SELECT state FROM guardian_requests WHERE id=?', episode.id)).state, 'expired');
    assert(saved.plan.events.every(event => event.scope.child_account_id === episode.account));
  }
});

for (const count of [32, 33]) test(count + ' selected declaration facts are ' + (count === 32 ? 'atomic' : 'rejected before domain writes'), async t => {
  const f = await family(t, { registered: true }), body = f.declareBody();
  let facts = await selectedFacts(f);
  for (let index = facts.length; index < count; index++) await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
    VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, randomUUID(), f.child.account_id, f.h.app.now());
  facts = await selectedFacts(f); assert.equal(facts.length, count);
  const before = await snapshot(f); f.trace.length = 0;
  if (count === 32) { await f.declare(body); await assertPlan(f, f.child.account_id, 'audience', body.operation_key, facts); assert.equal(await cursor(f), 32); }
  else {
    assert.equal((await f.declare(body, 503)).error.code, 'audience_restriction_capacity');
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'audience', body.operation_key)), null);
    const writes = f.trace.filter(item => item.kind === 'sql' && /^(UPDATE|INSERT|DELETE) /.test(item.sql));
    const housekeeping = sql => sql.startsWith('UPDATE restore_control ') || sql.startsWith('DELETE FROM request_limits WHERE expires_at<') || sql.startsWith('INSERT INTO request_limits(key,hits,expires_at) VALUES(');
    assert(writes.every(item => housekeeping(item.sql)), 'Capacity cannot commit domain/receipt/cleanup changes');
  }
});

test('cached withdrawal receipts still require current session authority', async t => {
  const f = await family(t), body = f.withdrawalBody(); await f.withdraw(body);
  const id = await restoreOperationID(f.child.account_id, 'guardian', body.operation_key), saved = await f.journal.lookup(id);
  await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.child.account_id);
  await f.withdraw(body, 401); assert.deepEqual(await f.journal.lookup(id), saved);
});

test('a cached adulthood review cannot bypass independently revoked reviewer authority', async t => {
  const f = await family(t), body = f.adultBody(); await f.adult(body);
  const id = await restoreOperationID(f.reviewer.accountId, 'audience', body.operation_key), saved = await f.journal.lookup(id);
  const before = await snapshot(f);
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', f.reviewer.accountId);
  const stale = await f.adult(body, 401);
  assert.equal(stale.error.code, 'session_invalid');
  assert.deepEqual(await f.journal.lookup(id), saved); assert.deepEqual(await snapshot(f), before);
  // Current-role sessions and stale role-bearing tokens have distinct denials.
  // A fresh ordinary-user login must still fail before the cached result.
  const challenge = await f.json('/auth/face/challenge', { body: {
    face_handle: f.reviewer.faceHandle, device_id: f.reviewer.deviceId } }, 201);
  const logged = await f.json('/auth/face/complete', { body: await captureProofs(f.h, challenge, f.reviewer.keys.privateKey) });
  assert.deepEqual(logged.roles, ['user']);
  const ordinary = await f.json('/admin/audience/' + f.child.account_id + '/adult-review', { token: logged.access_token, body }, 403);
  assert.equal(ordinary.error.code, 'admin_required');
  assert.deepEqual(await f.journal.lookup(id), saved); assert.deepEqual(await snapshot(f), before);
});

test('concurrent different-key withdrawals produce one exact terminal episode', async t => {
  const f = await family(t), first = f.withdrawalBody(), second = f.withdrawalBody(), facts = await selectedFacts(f);
  const path = '/guardian-requests/' + f.requestID + '/withdraw';
  const responses = await Promise.all([f.request(path, { body: first }), f.request(path, { body: second })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  await Promise.all(responses.map(response => response.body?.cancel()));
  const records = await Promise.all([first, second].map(async body => f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key))));
  assert.equal(records.filter(Boolean).length, 1);
  assert.equal(await cursor(f), facts.length); assert.equal((await requestRow(f)).state, 'withdrawn');
});

test('replacement expiry during fact preparation cannot trigger an unrecorded child-authority revocation', async t => {
  const f = await family(t, { registered: true }), replacement = randomUUID(), now = f.h.app.now(); let clock = now;
  f.context.now = () => clock;
  await f.h.db.run(`INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at)
    VALUES(?,?,'pending',1,?,?,?)`, replacement, f.child.account_id, AUDIENCE_POLICY, now + 1, now + 1000);
  const before = await snapshot(f), body = f.withdrawalBody(), all = f.db.all.bind(f.db); let armed = true;
  f.db.all = async (sql, ...bindings) => {
    const result = await all(sql, ...bindings);
    if (armed && sql.startsWith('SELECT id,child_account_id,guardian_account_id,purpose,status,version,revoked_at')) {
      armed = false; clock = now + 2000;
    }
    return result;
  };
  assert.equal((await f.withdraw(body, 409)).error.code, 'audience_authority_changed');
  assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key)), null);
});

test('journal outage denies declaration before domain writes and a fresh invocation can retry the original input', async t => {
  const f = await family(t), body = f.declareBody(), before = await snapshot(f);
  f.faults.control = true; await f.uncertain('/me/audience', { method: 'PUT', body });
  assert.deepEqual(await snapshot(f), before); f.faults.control = false;
  const facts = await selectedFacts(f); await f.declare(body);
  await assertPlan(f, f.child.account_id, 'audience', body.operation_key, facts);
});

for (const stage of ['before', 'after']) test('lost guardian-retirement prepare reply ' + stage + ' delivery rolls back all SQL without a partial manifest', async t => {
  const f = await family(t), body = f.withdrawalBody(), before = await snapshot(f);
  f.faults.reply = { path: '/v1/operations/prepare', stage };
  await f.uncertain('/guardian-requests/' + f.requestID + '/withdraw', { body });
  assert.equal(f.faults.reply, undefined); assert.deepEqual(await snapshot(f), before);
  const saved = await f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key));
  if (stage === 'before') assert.equal(saved, null);
  else { assert.equal(saved.status, 'pending'); assert.equal(saved.plan.events.length, 3); await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable); }
});

test('callback failure rolls back all relationship/consent/profile changes before journal acceptance', async t => {
  const f = await family(t, { registered: true }), body = f.withdrawalBody(), before = await snapshot(f), run = f.db.run.bind(f.db); let armed = true;
  f.db.run = async (sql, ...bindings) => {
    if (armed && sql.startsWith('UPDATE account_audience SET status=CASE')) { armed = false; throw Error('synthetic_audience_callback_failure'); }
    return run(sql, ...bindings);
  };
  await f.uncertain('/guardian-requests/' + f.requestID + '/withdraw', { body });
  assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.child.account_id, 'guardian', body.operation_key)), null);
});

test('accepted expiry plan with rejected SQL commit preserves pending facts and refuses callback replay', async t => {
  const f = await family(t), id = await expiryID(f), facts = await selectedFacts(f); await expire(f);
  const before = await snapshot(f), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return saved; };
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)));
  assert.deepEqual(await snapshot(f), before); const saved = await f.journal.lookup(id); assert.equal(saved.status, 'pending');
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), facts);
  await assert.rejects(() => f.db.invocation(() => maintainAudience(f.context)), unavailable);
  assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test('withdrawal ' + mode + ' uncertainty preserves the exact SQL boundary and original result', async t => {
  const f = await family(t), body = f.withdrawalBody(), id = await restoreOperationID(f.child.account_id, 'guardian', body.operation_key);
  const facts = await selectedFacts(f), prepare = f.journal.prepare.bind(f.journal); let armed = true, boundary, withdrawals = 0;
  const run = f.db.run.bind(f.db);
  f.db.run = async (sql, ...bindings) => { if (sql.startsWith('UPDATE guardian_requests SET state=')) withdrawals++; return run(sql, ...bindings); };
  if (mode === 'commit') f.journal.prepare = async value => {
    const saved = await prepare(value);
    if (armed && value.operation_id === id) {
      armed = false; f.faults.commitReply = true;
      f.faults.afterCommit = async () => { delete f.faults.afterCommit; boundary = {
        journal: (await f.journal.lookup(id)).status, sql: (await requestRow(f)).state }; };
    }
    return saved;
  };
  else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode === 'ack-before' ? 'before' : 'after' };
  await f.uncertain('/guardian-requests/' + f.requestID + '/withdraw', { body });
  assert.equal((await requestRow(f)).state, 'withdrawn');
  const saved = await f.journal.lookup(id); assert(saved);
  if (mode === 'commit') { assert.deepEqual(boundary, { journal: 'pending', sql: 'withdrawn' }); assert.equal(f.faults.commitReply, false); }
  else {
    const path = '/v1/operations/' + id + '/acknowledge'; assert.equal(f.faults.reply, undefined);
    assert(f.trace.some(value => value.kind === 'journal' && value.path === path));
    assert.equal(f.trace.some(value => value.kind === 'journal_ok' && value.path === path), mode === 'ack-after');
    assert.equal(saved.status, mode === 'ack-before' ? 'pending' : 'committed');
  }
  await f.withdraw(body); const committed = await assertPlan(f, f.child.account_id, 'guardian', body.operation_key, facts);
  assert.equal(committed.plan_hash, saved.plan_hash); assert.equal(withdrawals, 1); assert.equal(await cursor(f), facts.length);
});
