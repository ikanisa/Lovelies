import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {startHarness, closeHarnesses, enroll, captureProofs, faceVerifierFixture} from './runtime-harness.mjs';
import {AUDIENCE_POLICY, maintainAudience} from '../src/audience.ts';
import {prepareOperation, retiredOperationInput, retiredOperationResponse} from '../src/operations.ts';
import {pruneRetainedMetadata} from '../src/retention.ts';

after(closeHarnesses);
const DAY = 86400000, key = () => crypto.randomUUID();
const prune = (h, maximum = 100) => pruneRetainedMetadata(h.app, maximum);
async function pruneUntil(h, condition, maximum = 100) {
    for (let pass = 0; pass < 8 && !await condition(); pass++) await prune(h, maximum);
    assert(await condition(), 'Bounded cursor continuation reaches the eligible source');
}
const saved = (h, operation) => h.db.one('SELECT * FROM operations WHERE operation_key=?', operation);
const identity = row => Object.fromEntries(['actor_id', 'source', 'operation_key', 'action', 'payload_hash', 'created_at'].map(name => [name, row[name]]));
const retired = row => { assert.equal(row.payload_json, retiredOperationInput); assert.equal(row.response_json, retiredOperationResponse); };
async function administrator(h) {
    const person = await enroll(h);
    await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', person.accountId);
    const challenge = await h.json('/auth/face/challenge', {body: {face_handle: person.faceHandle, device_id: person.deviceId}}, 201);
    const credentials = await h.json('/auth/face/complete', {body: await captureProofs(h, challenge, person.keys.privateKey)});
    return {...person, token: credentials.access_token};
}
async function support(h, owner, details = 'Synthetic support narrative') {
    const body = {subject: 'Photo support', details, operation_key: key()};
    return {body, record: await h.json('/support/requests', {token: owner.token, body}, 201)};
}
async function ageSupport(h, id) {
    await h.db.run("UPDATE support_requests SET status='closed',created_at=?,updated_at=? WHERE id=?", Date.now() - 92 * DAY, Date.now() - 91 * DAY, id);
}
async function seedOperation(h, actor, action, source, body, result) {
    const intent = await prepareOperation(action, body, source);
    await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', actor, source, intent.key, action, intent.hash, intent.payloadJson, JSON.stringify(result), Date.now() - 400 * DAY);
    await h.db.run('INSERT INTO operation_subjects(actor_id,source,operation_key,subject_id) VALUES(?,?,?,?)', actor, source, intent.key, actor);
    return intent.key;
}
async function malformedCopiesStay(h, operation, table, id, cases) {
    const original = await saved(h, operation);
    for (const [label, inputChange, resultChange] of cases) {
        const input = JSON.parse(original.payload_json), result = JSON.parse(original.response_json);
        inputChange?.(input); resultChange?.(result);
        const intent = await prepareOperation(original.action, input, original.source);
        await h.db.run('UPDATE operations SET payload_hash=?,payload_json=?,response_json=? WHERE operation_key=?', intent.hash, intent.payloadJson, JSON.stringify(result), operation);
        const changed = await saved(h, operation);
        // Two bounded passes include this source even if the previous pass left
        // its class cursor immediately after it. The hash is valid in each case.
        await prune(h); await prune(h);
        assert(await h.db.one(`SELECT id FROM ${table} WHERE id=?`, id), label + ': source preserved');
        assert.deepEqual(await saved(h, operation), changed, label + ': malformed copy preserved');
    }
    await h.db.run('UPDATE operations SET payload_hash=?,payload_json=?,response_json=? WHERE operation_key=?', original.payload_hash, original.payload_json, original.response_json, operation);
}

test('support retirement removes original and reviewed copies in bounded batches; retired keys cannot replay or reconcile as success', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const owner = await enroll(h), admin = await administrator(h), other = await enroll(h);
        const narrative = 'PRIVATE_NARRATIVE_' + key(), notes = 'PRIVATE_REVIEW_' + key();
        const item = await support(h, owner, narrative);
        const review = {expected_revision: 1, review_notes: notes, operation_key: key()};
        await h.json(`/admin/support-requests/${item.record.id}/approve`, {token: admin.token, body: review});
        await ageSupport(h, item.record.id);
        const before = [await saved(h, item.body.operation_key), await saved(h, review.operation_key)];
        const links = await h.db.all("SELECT * FROM operation_subjects WHERE source='support' ORDER BY actor_id,operation_key,subject_id");
        await prune(h);
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id), 'Unfinished notification delivery keeps the source and full receipts');
        assert.equal((await saved(h, item.body.operation_key)).payload_json, before[0].payload_json);
        // Controlled fixture: no provider send is claimed. The related inbox-only
        // outcome releases the delivery barrier for the retention procedure.
        await h.db.run("UPDATE notification_jobs SET status='inbox_only' WHERE notification_id IN(SELECT id FROM notifications WHERE entity_id=?)", item.record.id);
        await pruneUntil(h, async () => (await h.db.one("SELECT count(*) n FROM operations WHERE source='support' AND payload_json=?", retiredOperationInput)).n === 1, 1);
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        assert.equal((await h.db.one("SELECT count(*) n FROM operations WHERE source='support' AND payload_json=?", retiredOperationInput)).n, 1);
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id) === null, 1);
        assert.equal(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id), null);
        for (const [index, operation] of [item.body.operation_key, review.operation_key].entries()) {
            const row = await saved(h, operation); retired(row); assert.deepEqual(identity(row), identity(before[index]));
        }
        assert.deepEqual(await h.db.all("SELECT * FROM operation_subjects WHERE source='support' ORDER BY actor_id,operation_key,subject_id"), links);
        const copies = JSON.stringify(await h.db.all("SELECT * FROM operations WHERE source='support'"));
        assert(!copies.includes(narrative)); assert(!copies.includes(notes));
        assert.equal((await h.json('/support/requests', {token: owner.token, body: item.body}, 410)).error.code, 'operation_receipt_retired');
        assert.equal((await h.json('/support/requests', {token: owner.token, body: {...item.body, details: 'Changed original input'}}, 409)).error.code, 'operation_key_conflict');
        await h.json(`/admin/support-requests/${item.record.id}/approve`, {token: admin.token, body: review}, 410);
        await h.community(owner.token, 'operation', {operation_key: item.body.operation_key}, 410);
        assert.deepEqual(await h.community(other.token, 'operation', {operation_key: item.body.operation_key}), {status: 'unknown'});
        assert.equal((await h.db.one('SELECT count(*) n FROM support_requests')).n, 0);
        await prune(h); retired(await saved(h, item.body.operation_key));

        // Partial markers never return a saved success; conflicts and current
        // session authority retain their existing precedence.
        await h.db.run('UPDATE operations SET response_json=? WHERE operation_key=?', '{}', item.body.operation_key);
        await h.json('/support/requests', {token: owner.token, body: item.body}, 503);
        await h.community(owner.token, 'operation', {operation_key: item.body.operation_key}, 503);
        await h.json('/support/requests', {token: owner.token, body: {...item.body, details: 'Changed original input'}}, 409);
        await h.db.run('UPDATE operations SET response_json=? WHERE operation_key=?', retiredOperationResponse, item.body.operation_key);
        await h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', Date.now(), owner.accountId);
        await h.json('/support/requests', {token: owner.token, body: item.body}, 401);
        assert.equal((await h.db.one('SELECT count(*) n FROM support_requests')).n, 0);
    } finally { await h.close(); }
});

test('source retirement respects exact deadlines, open cases, holds, writers, cleanup and outbox obligations', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const owner = await enroll(h), item = await support(h, owner), open = await support(h, owner, 'Keep this open case');
        await h.db.run('UPDATE support_requests SET created_at=?,updated_at=? WHERE id=?', Date.now() - 400 * DAY, Date.now() - 400 * DAY, open.record.id);
        await h.db.run("UPDATE support_requests SET status='closed',updated_at=? WHERE id=?", Date.now() - 89 * DAY, item.record.id);
        await prune(h); assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await ageSupport(h, item.record.id);
        await h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");
        await prune(h); assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
        const hold = key();
        await h.db.run('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,?)', hold, owner.accountId, Date.now(), 'Scoped synthetic hold');
        await prune(h); assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await h.db.run('UPDATE moderation_holds SET active=0 WHERE id=?', hold);
        const writer = key(), cleanup = key(), outbox = key();
        await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)", writer, owner.accountId, 'fixture-writer/' + writer, Date.now());
        await prune(h); assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?', writer)).status, 'pending');
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", Date.now(), writer);
        await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)", cleanup, owner.accountId, 'fixture-cleanup/' + cleanup, Date.now());
        await prune(h); assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?', cleanup)).status, 'pending');
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await h.db.run("UPDATE cleanup_intents SET status='verified',verified_at=? WHERE id=?", Date.now(), cleanup);
        await h.db.run('INSERT INTO outbox(id,account_id,category,entity_id,event_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', outbox, owner.accountId, 'support', item.record.id, 'fixture:' + outbox, '{}', Date.now());
        await prune(h); assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        await h.db.run('UPDATE outbox SET delivered_at=? WHERE id=?', Date.now(), outbox);
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id) === null);
        assert.equal(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id), null);
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', open.record.id));
        assert.notEqual((await saved(h, open.body.operation_key)).payload_json, retiredOperationInput);
        retired(await saved(h, item.body.operation_key));
        assert(await h.db.one('SELECT id FROM media_write_intents WHERE id=?', writer));
        assert(await h.db.one('SELECT id FROM cleanup_intents WHERE id=?', cleanup));
        assert(await h.db.one('SELECT id FROM outbox WHERE id=?', outbox));
    } finally { await h.close(); }
});

test('guardian purge keeps active approvals and minimizes every positively bound terminal receipt before source deletion', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const child = await h.anonymous(), guardian = await enroll(h), reviewer = await administrator(h);
        await h.json('/me/audience', {method: 'PUT', token: child.access_token, body: {age_band: '13_17', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
        const create = {expected_version: 1, policy_version: AUDIENCE_POLICY, operation_key: key()};
        const request = (await h.json('/me/guardian-requests', {token: child.access_token, body: create}, 201)).guardian_request;
        const claim = {expected_revision: 1, relationship_attested: true, purposes: ['face_authentication'], policy_version: AUDIENCE_POLICY, operation_key: key()};
        await h.json(`/guardian-requests/${request.id}/claim`, {token: guardian.token, body: claim});
        const evidence = 'private-evidence-' + key();
        const review = {expected_revision: 2, decision: 'approve', evidence_method: 'independent_live_review', evidence_reference: evidence, adult_verified: true, parental_responsibility_verified: true, policy_version: AUDIENCE_POLICY, operation_key: key()};
        await h.json(`/admin/guardian-requests/${request.id}/review`, {token: reviewer.token, body: review});
        await h.db.run('UPDATE guardian_requests SET created_at=? WHERE id=?', Date.now() - 400 * DAY, request.id);
        await prune(h); assert.equal((await h.db.one('SELECT state FROM guardian_requests WHERE id=?', request.id)).state, 'approved');
        assert.notEqual((await saved(h, review.operation_key)).payload_json, retiredOperationInput);
        const withdraw = {expected_revision: 3, operation_key: key()};
        await h.json(`/guardian-requests/${request.id}/withdraw`, {token: child.access_token, body: withdraw});
        await h.db.run('UPDATE guardian_requests SET terminated_at=? WHERE id=?', Date.now() - 364 * DAY, request.id);
        await prune(h); assert(await h.db.one('SELECT id FROM guardian_requests WHERE id=?', request.id));
        await h.db.run('UPDATE guardian_requests SET terminated_at=? WHERE id=?', Date.now() - 366 * DAY, request.id);
        await maintainAudience(h.app);
        assert(await h.db.one('SELECT id FROM guardian_requests WHERE id=?', request.id), 'Audience expiry cannot remove the source before receipt retirement');
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM guardian_requests WHERE id=?', request.id) === null);
        assert.equal(await h.db.one('SELECT id FROM guardian_requests WHERE id=?', request.id), null);
        assert.equal((await h.db.one('SELECT count(*) n FROM guardian_purpose_approvals WHERE request_id=?', request.id)).n, 0);
        for (const body of [create, claim, review, withdraw]) retired(await saved(h, body.operation_key));
        assert(!JSON.stringify(await h.db.all("SELECT * FROM operations WHERE source='guardian'")).includes(evidence));
        await h.json('/me/guardian-requests', {token: child.access_token, body: create}, 410);
        await h.json(`/guardian-requests/${request.id}/claim`, {token: guardian.token, body: claim}, 410);
        // Existing fresh-review/source guards retain their earlier precedence.
        await h.json(`/admin/guardian-requests/${request.id}/review`, {token: reviewer.token, body: review}, 404);
        assert.equal((await h.json('/me/audience', {token: child.access_token})).capabilities.face_authentication, false);
    } finally { await h.close(); }
});

test('adult review retirement requires an unambiguous exact evidence tuple and leaves the current declaration unchanged', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const person = await h.anonymous(), reviewer = await administrator(h);
        await h.json('/me/audience', {method: 'PUT', token: person.access_token, body: {age_band: 'under13', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
        const body = {expected_version: 1, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_live_review', evidence_reference: 'review-' + key(), adult_verified: true, operation_key: key()};
        await h.json(`/admin/audience/${person.account_id}/adult-review`, {token: reviewer.token, body});
        const review = await h.db.one('SELECT * FROM audience_adult_reviews WHERE account_id=?', person.account_id), duplicate = key();
        await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', Date.now() - 366 * DAY, review.id);
        await h.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)', duplicate, review.account_id, review.reviewed_by, review.evidence_method, review.evidence_reference, Date.now() - 366 * DAY);
        await prune(h);
        assert.equal((await h.db.one('SELECT count(*) n FROM audience_adult_reviews WHERE account_id=?', person.account_id)).n, 2);
        assert.notEqual((await saved(h, body.operation_key)).payload_json, retiredOperationInput);
        // Remove only the duplicate introduced by this disposable fixture.
        await h.db.run('DELETE FROM audience_adult_reviews WHERE id=?', duplicate);
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', review.id) === null);
        assert.equal(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', review.id), null);
        retired(await saved(h, body.operation_key));
        assert.equal((await h.json('/me/audience', {token: person.access_token})).audience.age_band, '18_plus');
        await h.json(`/admin/audience/${person.account_id}/adult-review`, {token: reviewer.token, body}, 410);
    } finally { await h.close(); }
});

test('distinct legitimate adult/minor/adult reviews for one account/reviewer retire independently across cutoff dates', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const reviewer = await administrator(h), scenarios = [];
        for (const bothDue of [false, true]) {
            const person = await h.anonymous();
            await h.json('/me/audience', {method: 'PUT', token: person.access_token, body: {age_band: 'under13', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
            const firstBody = {expected_version: 1, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_live_review', evidence_reference: 'first-cycle-' + key(), adult_verified: true, operation_key: key()};
            await h.json(`/admin/audience/${person.account_id}/adult-review`, {token: reviewer.token, body: firstBody});
            await h.json('/me/audience', {method: 'PUT', token: person.access_token, body: {age_band: '13_17', expected_version: 2, policy_version: AUDIENCE_POLICY, operation_key: key()}});
            const secondBody = {expected_version: 3, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_document_review', evidence_reference: 'second-cycle-' + key(), adult_verified: true, operation_key: key()};
            await h.json(`/admin/audience/${person.account_id}/adult-review`, {token: reviewer.token, body: secondBody});
            const first = await h.db.one('SELECT * FROM audience_adult_reviews WHERE evidence_reference=?', firstBody.evidence_reference);
            const second = await h.db.one('SELECT * FROM audience_adult_reviews WHERE evidence_reference=?', secondBody.evidence_reference);
            await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', Date.now() - 370 * DAY, first.id);
            await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', Date.now() - (bothDue ? 366 : 364) * DAY, second.id);
            scenarios.push({person, bothDue, first, second, firstBody, secondBody, recentSource: await h.db.one('SELECT * FROM audience_adult_reviews WHERE id=?', second.id), recentCopy: await saved(h, secondBody.operation_key)});
        }
        const recent = scenarios[0], duplicate = key();
        await h.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)', duplicate, recent.second.account_id, recent.second.reviewed_by, recent.second.evidence_method, recent.second.evidence_reference, recent.recentSource.created_at);
        await prune(h); await prune(h);
        assert(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', recent.first.id), 'Ambiguous other tuple cannot authorize source retirement');
        assert.notEqual((await saved(h, recent.firstBody.operation_key)).payload_json, retiredOperationInput);
        assert.deepEqual(await saved(h, recent.secondBody.operation_key), recent.recentCopy);
        // This duplicate belongs only to the explicitly disposable fixture.
        await h.db.run('DELETE FROM audience_adult_reviews WHERE id=?', duplicate);
        await malformedCopiesStay(h, recent.secondBody.operation_key, 'audience_adult_reviews', recent.first.id, [
            ['malformed other review remains unresolved', input => { delete input.adult_verified; }],
        ]);
        await pruneUntil(h, async () => (await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', scenarios[0].first.id)) === null &&
            (await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', scenarios[1].first.id)) === null &&
            (await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', scenarios[1].second.id)) === null);
        for (const scenario of scenarios) {
            retired(await saved(h, scenario.firstBody.operation_key));
            assert.equal((await h.json('/me/audience', {token: scenario.person.access_token})).audience.age_band, '18_plus');
            if (scenario.bothDue) retired(await saved(h, scenario.secondBody.operation_key));
        }
        assert.deepEqual(await h.db.one('SELECT * FROM audience_adult_reviews WHERE id=?', recent.second.id), recent.recentSource);
        assert.deepEqual(await saved(h, recent.secondBody.operation_key), recent.recentCopy);
        await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', Date.now() - 366 * DAY, recent.second.id);
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', recent.second.id) === null);
        retired(await saved(h, recent.secondBody.operation_key));
    } finally { await h.close(); }
});

test('persisted adult receipt scans pass more than twenty intact recent reviews and restart for a backdated new audience generation', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const reviewer = await administrator(h), person = await h.anonymous(), records = [], now = Date.now();
        await h.json('/me/audience', {method: 'PUT', token: person.access_token, body: {age_band: 'under13', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
        async function nextReview(index) {
            if (index) await h.json('/me/audience', {method: 'PUT', token: person.access_token, body: {age_band: '13_17', expected_version: index * 2, policy_version: AUDIENCE_POLICY, operation_key: key()}});
            const body = {expected_version: index * 2 + 1, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_live_review', evidence_reference: 'receipt-scan-' + key(), adult_verified: true, operation_key: key()};
            await h.json(`/admin/audience/${person.account_id}/adult-review`, {token: reviewer.token, body});
            const review = await h.db.one('SELECT * FROM audience_adult_reviews WHERE evidence_reference=?', body.evidence_reference);
            await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', now - (index ? 364 : 370) * DAY + index, review.id);
            await h.db.run('UPDATE operations SET created_at=? WHERE operation_key=?', now - 400 * DAY + index, body.operation_key);
            return {body, review: await h.db.one('SELECT * FROM audience_adult_reviews WHERE id=?', review.id), copy: await saved(h, body.operation_key)};
        }
        for (let index = 0; index < 23; index++) records.push(await nextReview(index));
        const old = records[0], declaration = await h.db.one('SELECT * FROM account_audience WHERE account_id=?', person.account_id);
        await prune(h);
        retired(await saved(h, old.body.operation_key));
        assert(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', old.review.id), 'One bounded batch cannot prove the unexamined recent prefix');
        const checkpoint = await h.db.one("SELECT * FROM retention_scan_cursors WHERE scan='adult' AND entity_id=?", old.review.id);
        assert(checkpoint?.last_id, 'The receipt continuation survives a new invocation');
        await prune(h); // Exhaustion wraps only the source-class cursor.
        const proof = JSON.parse(checkpoint.last_id);
        for (const invalid of ['{', JSON.stringify({...proof, protocol: 'unknown'}), JSON.stringify({...proof, extra: true}), JSON.stringify({...proof, generation: 1}), JSON.stringify({...proof, operation_key: 'short'})]) {
            await h.db.run("UPDATE retention_scan_cursors SET last_id=? WHERE scan='adult' AND entity_id=?", invalid, old.review.id);
            await assert.rejects(prune(h), {status: 503, code: 'retention_cursor_invalid'});
            assert(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', old.review.id), 'Unknown receipt cursor shapes fail closed');
        }
        await h.db.run("UPDATE retention_scan_cursors SET last_id=? WHERE scan='adult' AND entity_id=?", checkpoint.last_id, old.review.id);

        // A supported new adult/minor/adult cycle changes the proof generation.
        // Its fixture clock orders the new receipt before the saved checkpoint;
        // a duplicate tuple must still be seen rather than silently skipped.
        const added = await nextReview(23), duplicate = key();
        await h.db.run('UPDATE operations SET created_at=? WHERE operation_key=?', now - 401 * DAY, added.body.operation_key);
        added.copy = await saved(h, added.body.operation_key);
        await h.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)', duplicate, added.review.account_id, added.review.reviewed_by, added.review.evidence_method, added.review.evidence_reference, added.review.created_at);
        await pruneRetainedMetadata({...h.app}); await pruneRetainedMetadata({...h.app});
        assert(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', old.review.id), 'Changed generation rechecks a backdated ambiguous receipt before purge');
        assert.deepEqual(await saved(h, added.body.operation_key), added.copy);
        // Remove only the duplicate introduced by this disposable fixture.
        await h.db.run('DELETE FROM audience_adult_reviews WHERE id=?', duplicate);
        for (let pass = 0; pass < 6 && await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', old.review.id); pass++) await pruneRetainedMetadata({...h.app});
        assert.equal(await h.db.one('SELECT id FROM audience_adult_reviews WHERE id=?', old.review.id), null, 'Durable bounded batches pass all intact other receipts');
        assert.equal(await h.db.one("SELECT entity_id FROM retention_scan_cursors WHERE scan='adult' AND entity_id=?", old.review.id), null, 'Source deletion removes only its completed receipt checkpoint');
        for (const record of [...records.slice(1), added]) {
            assert.deepEqual(await h.db.one('SELECT * FROM audience_adult_reviews WHERE id=?', record.review.id), record.review);
            assert.deepEqual(await saved(h, record.body.operation_key), record.copy);
        }
        const current = await h.db.one('SELECT * FROM account_audience WHERE account_id=?', person.account_id);
        assert.equal(current.version, declaration.version + 2);
        assert.equal(current.age_band, '18_plus');
    } finally { await h.close(); }
});

test('known terminal privacy operation copies retire without removing minimal request/status facts or pending requests', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const owner = await enroll(h), admin = await administrator(h);
        const body = {reason: 'Private export explanation ' + key(), operation_key: key()};
        const request = (await h.json('/privacy/export', {token: owner.token, body}, 201)).privacy_request;
        const review = {reason: 'Private review explanation ' + key(), operation_key: key()};
        await h.json(`/privacy-requests/${request.id}/reject`, {token: admin.token, body: review});
        await h.db.run('UPDATE privacy_requests SET created_at=?,reviewed_at=? WHERE id=?', Date.now() - 367 * DAY, Date.now() - 366 * DAY, request.id);
        const facts = await h.db.one('SELECT * FROM privacy_requests WHERE id=?', request.id);
        const pendingBody = {reason: 'Keep unresolved request', operation_key: key()};
        const pending = (await h.json('/privacy/export', {token: owner.token, body: pendingBody}, 201)).privacy_request;
        await h.db.run('UPDATE privacy_requests SET created_at=? WHERE id=?', Date.now() - 400 * DAY, pending.id);
        await prune(h);
        retired(await saved(h, body.operation_key)); retired(await saved(h, review.operation_key));
        assert.deepEqual(await h.db.one('SELECT * FROM privacy_requests WHERE id=?', request.id), facts);
        assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?', pending.id)).status, 'pending_approval');
        assert.notEqual((await saved(h, pendingBody.operation_key)).payload_json, retiredOperationInput);
        await h.json(`/privacy/operations/${body.operation_key}`, {token: owner.token}, 410);
        await h.community(owner.token, 'operation', {operation_key: body.operation_key}, 410);
        await h.json('/privacy/export', {token: owner.token, body}, 410);
        await h.json('/privacy/export', {token: owner.token, body: {...body, reason: 'Changed reason'}}, 409);
        assert.equal((await h.json(`/privacy-requests/${request.id}`, {token: owner.token})).privacy_request.status, 'rejected');
    } finally { await h.close(); }
});

test('unknown/malformed linked actions and orphan receipts are preserved; source removal and receipt minimization roll back together', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const owner = await enroll(h), item = await support(h, owner);
        await ageSupport(h, item.record.id);
        const unknown = await seedOperation(h, owner.accountId, 'support.future-action', 'support', {request_id: item.record.id, operation_key: key()}, {id: item.record.id});
        const orphan = await seedOperation(h, owner.accountId, 'support.create', 'support', {subject: 'Orphan fixture', details: 'Preserved unknown source', operation_key: key()}, {id: key()});
        const unrelated = await seedOperation(h, owner.accountId, 'store.future-receipt', 'store', {operation_key: key()}, {id: item.record.id, financial: 'keep'});
        const originals = await Promise.all([item.body.operation_key, unknown, orphan, unrelated].map(operation => saved(h, operation)));
        await prune(h);
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        assert.deepEqual(await Promise.all([item.body.operation_key, unknown, orphan, unrelated].map(operation => saved(h, operation))), originals);
        // Remove only the unsupported linked fixture so the known source can
        // reach its normal purge boundary; orphan and foreign-source rows stay.
        await h.db.run('DELETE FROM operations WHERE operation_key=?', unknown);
        // Exhaust the prior blocked record's cursor before injecting the next
        // source transaction failure; this pass must not touch its full receipt.
        await prune(h);
        assert.deepEqual(await saved(h, item.body.operation_key), originals[0]);
        const run = h.db.run.bind(h.db);
        h.db.run = async (sql, ...bindings) => {
            if (sql.startsWith('DELETE FROM support_requests WHERE id=?') && bindings[0] === item.record.id) throw new Error('synthetic_terminal_purge_failure');
            return run(sql, ...bindings);
        };
        try { await assert.rejects(prune(h), /synthetic_terminal_purge_failure/); }
        finally { h.db.run = run; }
        assert(await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id));
        assert.deepEqual(await saved(h, item.body.operation_key), originals[0]);
        await prune(h); retired(await saved(h, item.body.operation_key));
        assert.deepEqual(await saved(h, orphan), originals[2]); assert.deepEqual(await saved(h, unrelated), originals[3]);
    } finally { await h.close(); }
});

test('hash-intact linked copies with missing or wrongly typed known-contract fields preserve every terminal source', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const owner = await enroll(h), admin = await administrator(h);
        const item = await support(h, owner), startReview = {expected_revision: 1, review_notes: null, sla_due_at: null, operation_key: key()}, supportReview = {expected_revision: 2, operation_key: key()};
        await h.json(`/admin/support-requests/${item.record.id}/start`, {token: admin.token, body: startReview});
        await h.json(`/admin/support-requests/${item.record.id}/approve`, {token: admin.token, body: supportReview});
        await ageSupport(h, item.record.id);
        await h.db.run("UPDATE notification_jobs SET status='inbox_only' WHERE notification_id IN(SELECT id FROM notifications WHERE entity_id=?)", item.record.id);
        await malformedCopiesStay(h, item.body.operation_key, 'support_requests', item.record.id, [
            ['support missing subject/details', input => { delete input.subject; delete input.details; }],
            ['support subject number', input => { input.subject = 12; }],
            ['support details array', input => { input.details = ['private']; }],
            ['support details from another source', input => { input.details = 'Different case narrative'; }],
            ['support missing result status', null, result => { delete result.status; }],
            ['support result revision string', null, result => { result.revision = '1'; }],
        ]);
        await malformedCopiesStay(h, supportReview.operation_key, 'support_requests', item.record.id, [
            ['support review missing revision', input => { delete input.expected_revision; }],
            ['support review revision string', input => { input.expected_revision = '1'; }],
            ['support review optional notes wrong type', input => { input.review_notes = false; }],
            ['support review optional SLA wrong type', input => { input.sla_due_at = true; }],
            ['support review result missing details', null, result => { delete result.support_request.details; }],
            ['support review result status wrong type', null, result => { result.support_request.status = 1; }],
        ]);
        await malformedCopiesStay(h, startReview.operation_key, 'support_requests', item.record.id, [
            ['support start missing result assignment', null, result => { delete result.support_request.assigned_to; }],
            ['support start has premature reviewed actor', null, result => { result.support_request.reviewed_by = admin.accountId; }],
        ]);
        await pruneUntil(h, async () => await h.db.one('SELECT id FROM support_requests WHERE id=?', item.record.id) === null);
        for (const body of [item.body, startReview, supportReview]) retired(await saved(h, body.operation_key));

        const child = await h.anonymous();
        await h.json('/me/audience', {method: 'PUT', token: child.access_token, body: {age_band: '13_17', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
        const create = {expected_version: 1, policy_version: AUDIENCE_POLICY, operation_key: key()};
        const guardian = (await h.json('/me/guardian-requests', {token: child.access_token, body: create}, 201)).guardian_request;
        const claim = {expected_revision: 1, relationship_attested: true, purposes: ['face_authentication'], policy_version: AUDIENCE_POLICY, operation_key: key()};
        await h.json(`/guardian-requests/${guardian.id}/claim`, {token: owner.token, body: claim});
        const review = {expected_revision: 2, decision: 'approve', evidence_method: 'independent_live_review', evidence_reference: 'review-' + key(), adult_verified: true, parental_responsibility_verified: true, policy_version: AUDIENCE_POLICY, operation_key: key()};
        await h.json(`/admin/guardian-requests/${guardian.id}/review`, {token: admin.token, body: review});
        const withdraw = {expected_revision: 3, operation_key: key()};
        await h.json(`/guardian-requests/${guardian.id}/withdraw`, {token: child.access_token, body: withdraw});
        await h.db.run('UPDATE guardian_requests SET terminated_at=? WHERE id=?', Date.now() - 366 * DAY, guardian.id);
        await malformedCopiesStay(h, create.operation_key, 'guardian_requests', guardian.id, [
            ['guardian create missing version', input => { delete input.expected_version; }],
            ['guardian create policy array', input => { input.policy_version = [AUDIENCE_POLICY]; }],
            ['guardian create result extra unknown field', null, result => { result.unknown = true; }],
        ]);
        await malformedCopiesStay(h, claim.operation_key, 'guardian_requests', guardian.id, [
            ['guardian claim missing relationship', input => { delete input.relationship_attested; }],
            ['guardian claim purpose wrong type', input => { input.purposes = 'face_authentication'; }],
            ['guardian claim purpose empty', input => { input.purposes = []; }],
            ['guardian claim result missing request ID', null, result => { delete result.request_id; }],
        ]);
        await malformedCopiesStay(h, review.operation_key, 'guardian_requests', guardian.id, [
            ['guardian approval missing adult verification', input => { delete input.adult_verified; }],
            ['guardian approval parental flag string', input => { input.parental_responsibility_verified = 'true'; }],
            ['guardian review decision array', input => { input.decision = ['approve']; }],
            ['guardian review evidence method array', input => { input.evidence_method = ['independent_live_review']; }],
            ['guardian review evidence reference wrong type', input => { input.evidence_reference = 123; }],
        ]);
        await malformedCopiesStay(h, withdraw.operation_key, 'guardian_requests', guardian.id, [
            ['guardian withdrawal missing revision', input => { delete input.expected_revision; }],
            ['guardian withdrawal revision string', input => { input.expected_revision = '3'; }],
        ]);

        const adult = await h.anonymous();
        await h.json('/me/audience', {method: 'PUT', token: adult.access_token, body: {age_band: 'under13', expected_version: 0, policy_version: AUDIENCE_POLICY, operation_key: key()}});
        const adultBody = {expected_version: 1, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_live_review', evidence_reference: 'adult-' + key(), adult_verified: true, operation_key: key()};
        await h.json(`/admin/audience/${adult.account_id}/adult-review`, {token: admin.token, body: adultBody});
        const adultRecord = await h.db.one('SELECT id FROM audience_adult_reviews WHERE account_id=?', adult.account_id);
        await h.db.run('UPDATE audience_adult_reviews SET created_at=? WHERE id=?', Date.now() - 366 * DAY, adultRecord.id);
        await malformedCopiesStay(h, adultBody.operation_key, 'audience_adult_reviews', adultRecord.id, [
            ['adult review missing expected version', input => { delete input.expected_version; }],
            ['adult review missing policy', input => { delete input.policy_version; }],
            ['adult review adult flag wrong type', input => { input.adult_verified = 'true'; }],
            ['adult review evidence method missing', input => { delete input.evidence_method; }],
            ['adult review result account missing', null, result => { delete result.account_id; }],
        ]);

        const privacyBody = {operation_key: key()}, privacy = (await h.json('/privacy/export', {token: owner.token, body: privacyBody}, 201)).privacy_request;
        const privacyReview = {operation_key: key(), reason: 'Synthetic rejection'};
        await h.json(`/privacy-requests/${privacy.id}/reject`, {token: admin.token, body: privacyReview});
        await h.db.run('UPDATE privacy_requests SET reviewed_at=? WHERE id=?', Date.now() - 366 * DAY, privacy.id);
        await malformedCopiesStay(h, privacyBody.operation_key, 'privacy_requests', privacy.id, [
            ['privacy reason wrong type', input => { input.reason = 17; }],
            ['export has unsupported deletion hash', input => { input.status_token_hash = 'a'.repeat(64); }],
            ['privacy result subject missing', null, result => { delete result.privacy_request.subject_user_id; }],
            ['privacy result reason missing', null, result => { delete result.privacy_request.reason; }],
        ]);
        await malformedCopiesStay(h, privacyReview.operation_key, 'privacy_requests', privacy.id, [
            ['privacy rejection reason missing', input => { delete input.reason; }],
            ['privacy review reason wrong type', input => { input.reason = false; }],
            ['privacy review result date wrong type', null, result => { result.privacy_request.reviewed_at = 17; }],
            ['privacy review delivery flag missing', null, result => { delete result.delivery_confirmed; }],
        ]);
    } finally { await h.close(); }
});

test('persisted bounded scans pass blocked oldest records and reach later eligible sources in every class', async () => {
    const h = await startHarness({faceVerifier: faceVerifierFixture, consumeQueue: false});
    try {
        const first = await enroll(h), second = await enroll(h), reviewer = await administrator(h), now = Date.now();
        for (const scan of ['support', 'guardian', 'adult', 'privacy']) {
            const records = [];
            for (const [index, owner] of [first, second].entries()) {
                const id = key(), at = now - (370 - index) * DAY, operation = key();
                let table, body, result, action, source;
                if (scan === 'support') {
                    table = 'support_requests'; source = 'support'; action = index ? 'support.create' : 'support.future-action';
                    await h.db.run("INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,'closed',?,?)", id, owner.accountId, 'Synthetic case', 'Synthetic private details', at - DAY, at);
                    body = {subject: 'Synthetic case', details: 'Synthetic private details', operation_key: operation}; result = {id, status: 'open', revision: 1};
                } else if (scan === 'guardian') {
                    table = 'guardian_requests'; source = 'guardian'; action = index ? 'guardian.create' : 'guardian.future-action';
                    await h.db.run("INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at,terminated_at) VALUES(?,?,'withdrawn',1,?,?,?,?)", id, owner.accountId, AUDIENCE_POLICY, at - DAY, at, at);
                    body = {expected_version: 1, policy_version: AUDIENCE_POLICY, operation_key: operation}; result = {request_id: id};
                } else if (scan === 'adult') {
                    table = 'audience_adult_reviews'; source = 'audience'; action = 'audience.adult-review';
                    const reference = 'fair-scan-' + key();
                    await h.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)', id, owner.accountId, reviewer.accountId, 'independent_live_review', reference, at);
                    body = {expected_version: 1, policy_version: AUDIENCE_POLICY, evidence_method: 'independent_live_review', evidence_reference: reference, adult_verified: index ? true : 'unknown', operation_key: operation, target_id: owner.accountId}; result = {account_id: owner.accountId};
                } else {
                    table = 'privacy_requests'; source = 'privacy'; action = 'privacy.request.export';
                    await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at) VALUES(?,?,?,'export','rejected',?,?,?,?)", id, owner.accountId, owner.accountId, at - DAY, at, reviewer.accountId, at);
                    body = {reason: index ? 'Synthetic export reason' : false, operation_key: operation};
                    result = {privacy_request: {id, request_type: 'export', subject_user_id: owner.accountId, requested_by: owner.accountId, status: 'pending_approval', reason: index ? body.reason : null}};
                }
                await seedOperation(h, scan === 'adult' ? reviewer.accountId : owner.accountId, action, source, body, result);
                records.push({id, operation, table, before: await h.db.one(`SELECT * FROM ${table} WHERE id=?`, id), copy: await saved(h, operation)});
            }
            await prune(h, 1);
            assert.equal((await h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan=? AND entity_id=''", scan)).last_id, records[0].id);
            assert.deepEqual(await saved(h, records[0].operation), records[0].copy);
            assert.notEqual((await saved(h, records[1].operation)).payload_json, retiredOperationInput);
            // New invocation context consumes the durable database continuation.
            await pruneRetainedMetadata({...h.app}, 1);
            retired(await saved(h, records[1].operation));
            assert.deepEqual(await h.db.one(`SELECT * FROM ${records[0].table} WHERE id=?`, records[0].id), records[0].before);
            assert.deepEqual(await saved(h, records[0].operation), records[0].copy);
            if (scan !== 'privacy') assert.equal(await h.db.one(`SELECT id FROM ${records[1].table} WHERE id=?`, records[1].id), null);
            else assert.deepEqual(await h.db.one('SELECT * FROM privacy_requests WHERE id=?', records[1].id), records[1].before);
        }
    } finally { await h.close(); }
});
