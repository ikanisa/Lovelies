import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, unavailable } from './restore-database-fixture.mjs';

const PHOTO_POLICY = 'photo-policy-fixture-v1';
const order = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
const consentFact = c => ({ kind: 'consent-withdrawn', scope: { account_id: c.account_id, consent_id: c.id, purpose: c.purpose } });
const requestFact = r => ({ kind: 'sharing-request-retired', scope: { sender_id: r.sender_id, recipient_id: r.recipient_id, request_id: r.id } });
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const logicalID = (f, body) => restoreOperationID(f.person.accountId, 'account', body.operation_key);
const planFor = async (f, body) => f.journal.lookup(await logicalID(f, body));
const consents = f => f.h.db.all('SELECT account_id,id,purpose,policy_version,status,revoked_at,expires_at FROM consents ORDER BY account_id,id');
const requests = f => f.h.db.all('SELECT id,sender_id,recipient_id,status,updated_at FROM sharing_requests ORDER BY id');
const grants = f => f.h.db.all('SELECT id,request_id,owner_id,recipient_id,active,revoked_at FROM media_grants ORDER BY id');
const snapshot = async f => ({ consents: await consents(f), requests: await requests(f), grants: await grants(f),
  preferences: await f.h.db.all('SELECT * FROM account_preferences ORDER BY account_id'),
  profiles: await f.h.db.all('SELECT account_id,id,revision,status,auth_enabled,auth_epoch,consent_id,auth_consent_id FROM face_profiles ORDER BY account_id'),
  states: await f.h.db.all('SELECT * FROM face_profile_states ORDER BY account_id'),
  lifecycle: await f.h.db.all('SELECT account_id,operation_key,state,consent_id FROM face_profile_operations ORDER BY account_id,operation_key') });

/** Enrollment uses the canonical routes. Sharing rows below are explicit
 * FK-consistent metadata fixtures, not a claim of optical matching or a real
 * sharing/Storage journey. Guarded mutations use actual PostgreSQL and journal. */
async function preferencesFixture(t, { sharing = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const person = await enroll(h), peer = await h.anonymous({ adult: true }), other = await h.anonymous({ adult: true });
  await h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    photo_matching_consent: true, processing_consent: true, policy_version: PHOTO_POLICY, operation_key: randomUUID() } });
  const makeRequest = async (sender, recipient, status = 'accepted') => {
    const asset = randomUUID(), snapshotID = randomUUID(), preview = randomUUID(), id = randomUUID(), now = h.app.now();
    await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
      VALUES(?,?,'personal','ready',?,'image/png',3,?,?,?)`, asset, sender, 'private/preference-fixture/' + asset, randomUUID(), 'PRIVATE PHOTO CAPTION', now);
    await h.db.run(`INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at)
      VALUES(?,?,'personal',?,'{}',?,?)`, snapshotID, sender, randomUUID(), now, now + 86400000);
    await h.db.run(`INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at)
      VALUES(?,?,?,'personal',?,1,?,'{}',?,?)`, preview, sender, snapshotID, randomUUID(), JSON.stringify([{ asset_id: asset, recipient_id: recipient }]), now, now + 86400000);
    await h.db.run(`INSERT INTO sharing_requests(id,preview_id,sender_id,recipient_id,source,asset_ids_json,status,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,'personal',?,?,?,?,?)`, id, preview, sender, recipient, JSON.stringify([asset]), status, now, now + 86400000, now);
    await h.db.run('INSERT INTO media_grants(id,request_id,owner_id,recipient_id,asset_id,active,created_at) VALUES(?,?,?,?,?,?,?)',
      randomUUID(), id, sender, recipient, asset, status === 'accepted' ? 1 : 0, now);
    return { id, sender_id: sender, recipient_id: recipient, asset };
  };
  const incoming = sharing ? await makeRequest(peer.account_id, person.accountId) : null;
  const outgoing = sharing ? await makeRequest(person.accountId, peer.account_id) : null;
  const unrelated = sharing ? await makeRequest(peer.account_id, other.account_id) : null;
  const pending = sharing ? await makeRequest(peer.account_id, person.accountId, 'requested') : null;
  const retired = sharing ? await makeRequest(person.accountId, peer.account_id, 'revoked') : null;
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const body = (fields = {}) => ({ policy_version: h.env.PHOTO_CONSENT_POLICY_VERSION ?? PHOTO_POLICY,
    operation_key: randomUUID(), ...fields });
  const request = (input, token = person.token) => handler(new Request('https://api.invalid/me/photo-preferences', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  const apply = async (input, expected = 200, token = person.token) => {
    const response = await request(input, token), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const uncertain = async input => {
    const response = await request(input); assert(response.status >= 500 && response.status <= 599);
    await response.body?.cancel();
  };
  return { ...f, person, peer, other, context, body, request, apply, uncertain, incoming, outgoing, unrelated, pending, retired, makeRequest };
}
async function expectedFacts(f, { purposes = [], recipient = false, owner = false } = {}) {
  const cs = (await consents(f)).filter(c => c.account_id === f.person.accountId && purposes.includes(c.purpose) && c.status === 'granted');
  const rs = (await requests(f)).filter(r => r.status === 'accepted' &&
    (recipient && r.recipient_id === f.person.accountId || owner && r.sender_id === f.person.accountId));
  return order([...cs.map(consentFact), ...rs.map(requestFact)]);
}
async function assertPlan(f, body, facts, status = 'committed') {
  const saved = await planFor(f, body); assert(saved); assert.equal(saved.status, status);
  assert.deepEqual(saved.plan.allocations, {}, 'New grant allocations remain a separate readiness task');
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), order(facts));
  assert.equal(new Set(saved.plan.events.map(e => e.operation_id)).size, facts.length);
  const receipt = await f.h.db.one('SELECT payload_hash FROM operations WHERE actor_id=? AND source=? AND operation_key=?', f.person.accountId, 'account', body.operation_key);
  if (receipt) assert.equal(saved.plan.input_hash, receipt.payload_hash);
  const text = JSON.stringify(saved.plan);
  for (const privateValue of [f.person.token, f.person.faceHandle, 'PRIVATE PHOTO CAPTION']) assert(!text.includes(privateValue));
  for (const name of ['asset_id', 'template_key', 'template_digest', 'access_token', 'refresh_token', 'active', 'payload_json'])
    assert(!text.includes('"' + name + '"'));
  return saved;
}

test('unchanged true/same-policy save preserves consent episodes and all accepted sharing with an empty restriction manifest', async t => {
  const f = await preferencesFixture(t);
  await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
    VALUES(?,?,'photo_processing','older-policy','granted',0)`, randomUUID(), f.person.accountId);
  const before = await snapshot(f), body = f.body({ receive_matches: true, photo_matching_consent: true, processing_consent: true });
  await f.apply(body); await assertPlan(f, body, []);
  const after = await snapshot(f); assert.deepEqual(after.consents, before.consents); assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(after.grants, before.grants); assert.deepEqual(after.profiles, before.profiles); assert.equal(await cursor(f), 0);
});

for (const [field, purpose, direction] of [['processing_consent', 'photo_processing', 'owner'], ['photo_matching_consent', 'photo_matching', 'recipient']])
  test(field + ' opt-out records only its old purpose and exact accepted sharing direction', async t => {
    const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ [field]: false });
    const facts = await expectedFacts(f, { purposes: [purpose], [direction]: true }); await f.apply(body); await assertPlan(f, body, facts);
    const after = await snapshot(f);
    for (const old of before.consents) {
      const current = after.consents.find(c => c.id === old.id);
      if (old.account_id === f.person.accountId && old.purpose === purpose && old.status === 'granted') assert.equal(current.status, 'revoked');
      else assert.deepEqual(current, old);
    }
    const target = direction === 'owner' ? f.outgoing : f.incoming, preserved = direction === 'owner' ? f.incoming : f.outgoing;
    assert.equal(after.requests.find(r => r.id === target.id).status, 'revoked'); assert.equal(after.grants.find(g => g.request_id === target.id).active, 0);
    for (const r of [preserved, f.unrelated, f.pending, f.retired]) assert.deepEqual(after.requests.find(x => x.id === r.id), before.requests.find(x => x.id === r.id));
    for (const g of before.grants.filter(g => g.request_id !== target.id)) assert.deepEqual(after.grants.find(x => x.id === g.id), g);
    assert.equal(after.profiles.find(p => p.account_id === f.person.accountId).status, 'active');
  });

test('combined opt-out registers one ordered complete mixed manifest and never invents an authentication/profile withdrawal', async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false, photo_matching_consent: false, receive_matches: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing', 'photo_matching'], recipient: true, owner: true });
  await f.apply(body); const saved = await assertPlan(f, body, facts);
  assert(saved.plan.events.every(e => e.kind !== 'consent-withdrawn' || e.scope.purpose !== 'face_authentication'));
  assert.equal(await cursor(f), facts.length);
});

test('receive_matches false alone retires accepted recipient requests without withdrawing any consent', async t => {
  const f = await preferencesFixture(t), before = await consents(f), body = f.body({ receive_matches: false });
  const facts = await expectedFacts(f, { recipient: true }); await f.apply(body); await assertPlan(f, body, facts);
  assert.deepEqual(await consents(f), before); assert.equal((await requests(f)).find(r => r.id === f.outgoing.id).status, 'accepted');
});

for (const [field, purpose, direction] of [['processing_consent', 'photo_processing', 'owner'], ['photo_matching_consent', 'photo_matching', 'recipient']])
  test('new-policy ' + field + ' renewal retires old episodes but preserves its fresh granted consent', async t => {
    const f = await preferencesFixture(t); f.h.env.PHOTO_CONSENT_POLICY_VERSION = 'photo-policy-fixture-v2';
    const body = f.body({ [field]: true }), before = await consents(f), facts = await expectedFacts(f, { purposes: [purpose], [direction]: true });
    await f.apply(body); const saved = await assertPlan(f, body, facts), after = await consents(f);
    const added = after.filter(c => !before.some(old => old.id === c.id)); assert.equal(added.length, 1);
    assert.equal(added[0].purpose, purpose); assert.equal(added[0].status, 'granted'); assert.equal(added[0].policy_version, body.policy_version);
    assert(!saved.plan.events.some(e => e.scope.consent_id === added[0].id));
    if (purpose === 'photo_matching') assert.equal((await snapshot(f)).profiles.find(p => p.account_id === f.person.accountId).consent_id, added[0].id);
  });

test('a missing purpose field does not revoke that purpose even when its policy is older', async t => {
  const f = await preferencesFixture(t), before = await consents(f); f.h.env.PHOTO_CONSENT_POLICY_VERSION = 'photo-policy-fixture-v2';
  const body = f.body({ processing_consent: false }), facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  await f.apply(body); await assertPlan(f, body, facts);
  assert.deepEqual((await consents(f)).filter(c => c.purpose === 'photo_matching'), before.filter(c => c.purpose === 'photo_matching'));
});

test('opt-out mirrors the broad granted-row UPDATE including expired episodes, while already-revoked rows stay outside its facts', async t => {
  const f = await preferencesFixture(t, { sharing: false }), expired = randomUUID(), revoked = randomUUID(), marked = randomUUID();
  await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,expires_at) VALUES(?,?,'photo_processing','older-policy','granted',1,2)`, expired, f.person.accountId);
  await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,revoked_at) VALUES(?,?,'photo_processing','older-policy','revoked',1,2)`, revoked, f.person.accountId);
  await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,revoked_at) VALUES(?,?,'photo_processing','older-policy','granted',1,2)`, marked, f.person.accountId);
  const body = f.body({ processing_consent: false }), facts = await expectedFacts(f, { purposes: ['photo_processing'] });
  await f.apply(body); const saved = await assertPlan(f, body, facts);
  assert(saved.plan.events.some(e => e.scope.consent_id === expired)); assert(!saved.plan.events.some(e => e.scope.consent_id === revoked));
  assert(saved.plan.events.some(e => e.scope.consent_id === marked));
  assert.equal((await consents(f)).find(c => c.id === revoked).revoked_at, 2);
});

test('repeated opt-out then fresh enable creates no invented withdrawal for already-retired or new episodes', async t => {
  const f = await preferencesFixture(t, { sharing: false }), disable = f.body({ processing_consent: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing'] }); await f.apply(disable); await assertPlan(f, disable, facts);
  const again = f.body({ processing_consent: false }); await f.apply(again); await assertPlan(f, again, []);
  const enable = f.body({ processing_consent: true }); await f.apply(enable); await assertPlan(f, enable, []);
  assert.equal((await consents(f)).filter(c => c.account_id === f.person.accountId && c.purpose === 'photo_processing' && c.status === 'granted').length, 1);
  assert.equal(await cursor(f), facts.length);
});

test('receive true without matching consent rolls every tentative preference change back and accepts no restriction plan', async t => {
  const f = await preferencesFixture(t, { sharing: false });
  await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'", f.h.app.now(), f.person.accountId);
  const before = await snapshot(f), body = f.body({ receive_matches: true, processing_consent: false });
  assert.equal((await f.apply(body, 403)).error.code, 'matching_consent_required'); assert.deepEqual(await snapshot(f), before);
  assert.equal(await planFor(f, body), null);
});

test('a fresh grant still requires current audience authority; denial rolls back old withdrawals', async t => {
  const f = await preferencesFixture(t); f.h.env.PHOTO_CONSENT_POLICY_VERSION = 'photo-policy-fixture-v2';
  await f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?", f.person.accountId);
  const before = await snapshot(f), body = f.body({ processing_consent: true });
  await f.apply(body, 403); assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
});

for (const invalid of ['policy', 'boolean']) test('invalid ' + invalid + ' input cannot reach the restriction collector or mutate preferences', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body(invalid === 'policy' ? { policy_version: 'unselected-policy', processing_consent: false } : { processing_consent: 'false' });
  await f.apply(body, 400); assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
});

for (const stage of ['before-transaction', 'after-plan', 'before-receipt'])
  test('current photo policy drift ' + stage + ' rejects stale renewal and preserves the original key', async t => {
    const f = await preferencesFixture(t), selectedPolicy = PHOTO_POLICY + '-renewal', newerPolicy = PHOTO_POLICY + '-next';
    f.h.env.PHOTO_CONSENT_POLICY_VERSION = selectedPolicy;
    const before = await snapshot(f), body = f.body({ processing_consent: true });
    const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
    const run = f.db.run.bind(f.db), writes = []; let armed = true;
    f.db.run = (sql, ...bindings) => { writes.push(sql); return run(sql, ...bindings); };
    if (stage === 'before-transaction') {
      const transaction = f.db.transaction.bind(f.db);
      // The preferences operation is the first mutation transaction. This hook
      // changes only env before entry; it performs no nested database read.
      f.db.transaction = (callback, intent) => {
        if (armed) { armed = false; f.h.env.PHOTO_CONSENT_POLICY_VERSION = newerPolicy; }
        return transaction(callback, intent);
      };
    } else if (stage === 'after-plan') {
      const all = f.db.all.bind(f.db); let ownerSelections = 0;
      f.db.all = async (sql, ...bindings) => {
        const result = await all(sql, ...bindings);
        if (armed && sql.startsWith('SELECT id,sender_id,recipient_id FROM sharing_requests WHERE sender_id=') && ++ownerSelections === 2) {
          armed = false; f.h.env.PHOTO_CONSENT_POLICY_VERSION = newerPolicy;
        }
        return result;
      };
    } else {
      const one = f.db.one.bind(f.db);
      f.db.one = async (sql, ...bindings) => {
        const result = await one(sql, ...bindings);
        if (armed && sql.startsWith('SELECT id FROM consents WHERE account_id=') && bindings[1] === 'photo_matching') {
          armed = false; f.h.env.PHOTO_CONSENT_POLICY_VERSION = newerPolicy;
        }
        return result;
      };
    }
    assert.equal((await f.apply(body, 400)).error.code, 'photo_policy_changed'); assert.equal(armed, false);
    if (stage === 'before-receipt') {
      assert(writes.some(sql => sql.startsWith("UPDATE consents SET status='revoked'")));
      assert(writes.some(sql => sql.startsWith('INSERT INTO consents(')));
    } else assert.equal(writes.length, 0, 'policy drift must be denied before any domain SQL write');
    assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
    assert.equal(await cursor(f), 0);
    assert.equal(await f.h.db.one('SELECT action FROM operations WHERE actor_id=? AND source=? AND operation_key=?',
      f.person.accountId, 'account', body.operation_key), null);
    // A rejected callback has no accepted plan or receipt; restoring the exact
    // selected policy permits this same original input/key to complete once.
    f.h.env.PHOTO_CONSENT_POLICY_VERSION = selectedPolicy;
    await f.apply(body); await assertPlan(f, body, facts);
    assert.equal(await cursor(f), facts.length);
    const active = (await consents(f)).filter(c => c.account_id === f.person.accountId && c.purpose === 'photo_processing' && c.status === 'granted');
    assert.equal(active.length, 1); assert.equal(active[0].policy_version, selectedPolicy);
  });

test('an existing preference receipt still requires the current photo policy before replay', async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  await f.apply(body); const saved = await assertPlan(f, body, facts), before = await snapshot(f);
  f.h.env.PHOTO_CONSENT_POLICY_VERSION = PHOTO_POLICY + '-next';
  assert.equal((await f.apply(body, 400)).error.code, 'photo_policy_changed');
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await planFor(f, body), saved);
  assert.equal(await cursor(f), facts.length);
});

test('anonymous authority cannot withdraw another account purpose or accept a preference journal plan', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ processing_consent: false });
  await f.apply(body, 403, f.peer.access_token); assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.peer.account_id, 'account', body.operation_key)), null);
  assert.equal(await planFor(f, body), null);
});

for (const revoked of ['session', 'device']) test('current ' + revoked + ' revocation denies mutation before any preference restriction is accepted', async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false });
  if (revoked === 'session') await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.person.accountId);
  else await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  const before = await snapshot(f), response = await f.request(body); assert([401, 403].includes(response.status)); await response.body?.cancel();
  assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
});

test('cached original preference result does not repeat domain writes and rejects altered payload or revoked-session replay', async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false }), facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  const run = f.db.run.bind(f.db); let withdrawals = 0;
  f.db.run = (sql, ...bindings) => { if (sql.startsWith("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose=?")) withdrawals++; return run(sql, ...bindings); };
  const result = await f.apply(body), saved = await assertPlan(f, body, facts);
  assert.deepEqual(await f.apply(body), result); assert.equal(withdrawals, 1); assert.equal(await cursor(f), facts.length);
  assert.equal((await f.apply({ ...body, processing_consent: true }, 409)).error.code, 'operation_key_conflict');
  await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.person.accountId);
  await f.apply(body, 401); assert.deepEqual(await planFor(f, body), saved);
});

test('concurrent distinct keys withdraw the old episodes once while the later no-op gets an empty manifest', async t => {
  const f = await preferencesFixture(t), first = f.body({ processing_consent: false }), second = f.body({ processing_consent: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  const responses = await Promise.all([f.request(first), f.request(second)]); assert(responses.every(r => r.status === 200));
  await Promise.all(responses.map(r => r.body?.cancel()));
  const plans = await Promise.all([planFor(f, first), planFor(f, second)]);
  assert.deepEqual(plans.map(p => p.plan.events.length).sort((a, b) => a - b), [0, facts.length]); assert.equal(await cursor(f), facts.length);
});

for (const count of [32, 33]) test(count + ' mixed consent/request facts are ' + (count === 32 ? 'atomic' : 'denied before domain writes'), async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false, photo_matching_consent: false });
  let facts = await expectedFacts(f, { purposes: ['photo_processing', 'photo_matching'], recipient: true, owner: true });
  for (let i = facts.length; i < count; i++) await f.h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
    VALUES(?,?,'photo_processing',?,'granted',1)`, randomUUID(), f.person.accountId, PHOTO_POLICY);
  facts = await expectedFacts(f, { purposes: ['photo_processing', 'photo_matching'], recipient: true, owner: true }); assert.equal(facts.length, count);
  const before = await snapshot(f), run = f.db.run.bind(f.db), writes = [];
  f.db.run = (sql, ...bindings) => { writes.push(sql); return run(sql, ...bindings); };
  if (count === 32) { await f.apply(body); await assertPlan(f, body, facts); assert.equal(await cursor(f), 32); }
  else {
    assert.equal((await f.apply(body, 503)).error.code, 'photo_preference_restriction_capacity');
    assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
    assert(!writes.some(sql => /^(?:INSERT(?: OR IGNORE)? INTO (?:account_preferences|consents|operations|face_profile_states)|UPDATE (?:account_preferences|consents|candidates|media_grants|sharing_requests|face_profiles|face_profile_states|face_profile_operations|auth_challenges))/.test(sql)));
  }
});

for (const stage of ['planning', 'after-first-write']) test('consent expiry during ' + stage + ' cannot change an unrecorded branch', async t => {
  const f = await preferencesFixture(t, { sharing: false }), now = f.h.app.now(); let clock = now, armed = true;
  f.context.now = () => clock;
  await f.h.db.run("UPDATE consents SET expires_at=? WHERE account_id=? AND purpose='photo_matching' AND status='granted'", now + 1000, f.person.accountId);
  const before = await snapshot(f), body = f.body({ processing_consent: false, photo_matching_consent: true });
  if (stage === 'planning') {
    const all = f.db.all.bind(f.db);
    f.db.all = async (sql, ...bindings) => { const result = await all(sql, ...bindings);
      if (armed && sql.startsWith('SELECT id,sender_id,recipient_id FROM sharing_requests WHERE sender_id=')) { armed = false; clock = now + 2000; }
      return result; };
  } else {
    const run = f.db.run.bind(f.db);
    f.db.run = async (sql, ...bindings) => { const result = await run(sql, ...bindings);
      if (armed && sql.startsWith('INSERT OR IGNORE INTO account_preferences(')) { armed = false; clock = now + 2000; }
      return result; };
  }
  assert.equal((await f.apply(body, 409)).error.code, 'photo_preference_authority_changed');
  assert.equal(armed, false); assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
});

for (const stage of ['planning', 'after-first-write']) test('a changed accepted-request subset during ' + stage + ' rolls back instead of accepting an incomplete manifest', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ receive_matches: false }), run = f.db.run.bind(f.db); let armed = true;
  if (stage === 'planning') {
    const all = f.db.all.bind(f.db);
    f.db.all = async (sql, ...bindings) => { const result = await all(sql, ...bindings);
      if (armed && sql.startsWith('SELECT id,sender_id,recipient_id FROM sharing_requests WHERE recipient_id=')) {
        armed = false; await run("UPDATE sharing_requests SET status='accepted' WHERE id=?", f.pending.id);
      } return result; };
  } else f.db.run = async (sql, ...bindings) => { const result = await run(sql, ...bindings);
    if (armed && sql.startsWith('INSERT OR IGNORE INTO account_preferences(')) { armed = false; await run("UPDATE sharing_requests SET status='accepted' WHERE id=?", f.pending.id); }
    return result; };
  assert.equal((await f.apply(body, 409)).error.code, 'photo_preference_authority_changed'); assert.equal(armed, false);
  assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
});

test('journal admission outage preserves all preference effects and an original-key fresh retry remains usable', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ processing_consent: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  f.faults.control = true; await f.uncertain(body); assert.deepEqual(await snapshot(f), before);
  f.faults.control = false; assert.equal(await planFor(f, body), null); await f.apply(body); await assertPlan(f, body, facts);
});

for (const stage of ['before', 'after']) test('lost prepare reply ' + stage + ' preserves the actual journal/SQL boundary', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ processing_consent: false });
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  const id = await logicalID(f, body), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = input => { if (armed && input.operation_id === id) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage }; } return prepare(input); };
  await f.uncertain(body); assert.equal(armed, false); assert.equal(f.faults.reply, undefined); assert.deepEqual(await snapshot(f), before);
  if (stage === 'before') { assert.equal(await planFor(f, body), null); await f.apply(body); await assertPlan(f, body, facts); }
  else {
    const saved = await assertPlan(f, body, facts, 'pending'); await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.uncertain(body); assert.deepEqual(await planFor(f, body), saved);
  }
});

test('callback failure rolls back preference/grant writes before independent prepare and the original key can retry', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ processing_consent: false }), run = f.db.run.bind(f.db); let armed = true;
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true });
  f.db.run = async (sql, ...bindings) => { const result = await run(sql, ...bindings);
    if (armed && sql.startsWith("UPDATE sharing_requests SET status='revoked'")) { armed = false; throw Error('synthetic_preference_callback_failure'); } return result; };
  await f.uncertain(body); assert.equal(armed, false); assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
  await f.apply(body); await assertPlan(f, body, facts);
});

test('accepted prepare with rejected PostgreSQL COMMIT preserves pending restrictions and cannot replay the callback', async t => {
  const f = await preferencesFixture(t), before = await snapshot(f), body = f.body({ processing_consent: false }), id = await logicalID(f, body);
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true }), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async input => { const result = await prepare(input);
    if (armed && input.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return result; };
  await f.uncertain(body); assert.deepEqual(await snapshot(f), before); const saved = await assertPlan(f, body, facts, 'pending');
  await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
  await f.uncertain(body); assert.deepEqual(await planFor(f, body), saved); assert.deepEqual(await snapshot(f), before);
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test(mode + ' loss preserves actual committed preference effects and returns the original receipt without another withdrawal', async t => {
  const f = await preferencesFixture(t), body = f.body({ processing_consent: false }), id = await logicalID(f, body);
  const facts = await expectedFacts(f, { purposes: ['photo_processing'], owner: true }), prepare = f.journal.prepare.bind(f.journal), run = f.db.run.bind(f.db);
  let armed = true, boundary, withdrawals = 0;
  f.db.run = (sql, ...bindings) => { if (sql.startsWith("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose=?")) withdrawals++; return run(sql, ...bindings); };
  f.journal.prepare = async input => {
    if (armed && input.operation_id === id) {
      armed = false;
      if (mode === 'commit') {
        f.faults.commitReply = true;
        f.faults.afterCommit = async () => { delete f.faults.afterCommit;
          boundary = { journal: (await planFor(f, body)).status,
            consent: (await consents(f)).filter(c => c.account_id === f.person.accountId && c.purpose === 'photo_processing').every(c => c.status === 'revoked'),
            request: (await requests(f)).find(r => r.id === f.outgoing.id).status };
        };
      } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
    }
    return prepare(input);
  };
  await f.uncertain(body);
  // The HTTP invocation's final fresh admission reconciles an exact COMMIT
  // whose reply was lost. A failed acknowledge poisons that invocation instead.
  const saved = await assertPlan(f, body, facts, mode === 'ack-before' ? 'pending' : 'committed');
  if (mode === 'commit') { assert.deepEqual(boundary, { journal: 'pending', consent: true, request: 'revoked' }); assert.equal(f.faults.commitReply, false); }
  else {
    const path = '/v1/operations/' + id + '/acknowledge'; assert.equal(f.faults.reply, undefined);
    assert(f.trace.some(item => item.kind === 'journal' && item.path === path));
    assert.equal(f.trace.some(item => item.kind === 'journal_ok' && item.path === path), mode === 'ack-after');
  }
  assert.equal((await requests(f)).find(r => r.id === f.outgoing.id).status, 'revoked');
  assert.equal((await grants(f)).find(g => g.request_id === f.outgoing.id).active, 0);
  const result = await f.apply(body); assert.equal(result.processing_consent, false);
  const committed = await assertPlan(f, body, facts); assert.equal(committed.plan_hash, saved.plan_hash);
  assert.equal(withdrawals, 1); assert.equal(await cursor(f), facts.length);
});
