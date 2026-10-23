import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify, randomUUID } from 'node:crypto';
import { ApnsAuthorization, FcmAuthorization, ApnsProvider, FcmProvider } from '../src/providers.mjs';
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key => key.export({ type: 'pkcs8', format: 'pem' });
const input = { token: 'a'.repeat(64), notification: { id: randomUUID(), title: 'A photo sharing request is waiting', kind: 'match', entity_id: randomUUID() } };
const account = { type: 'service_account', project_id: 'controlled-project', client_email: 'push@controlled-project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: pem(rsa.privateKey) };
function fakeSession(reply, observation) {
  const session = new EventEmitter(); session.closed = false; session.destroyed = false;
  session.request = headers => {
    observation.headers = headers; const stream = new EventEmitter(); stream.readableEnded = false;
    stream.close = () => stream.emit('close');
    stream.end = body => { observation.body = JSON.parse(body); if (!reply) return; queueMicrotask(() => { stream.emit('response', { ':status': reply.status, 'apns-id': reply.id ?? headers['apns-id'] }); if (reply.body) stream.emit('data', Buffer.from(JSON.stringify(reply.body))); stream.readableEnded = true; stream.emit('end'); stream.emit('close'); }); };
    return stream;
  };
  session.close = () => { session.closed = true; session.emit('close'); }; session.destroy = session.close; return session;
}
test('APNs authorization produces valid raw ES256 and reuses/rotates bounded provider JWT', () => {
  let time = Date.now(); const auth = new ApnsAuthorization({ teamID: 'ABCDEFGHIJ', keyID: '1234567890', privateKey: pem(ec.privateKey), now: () => time });
  const first = auth.token(), [header, claims, signature] = first.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: '1234567890' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'ABCDEFGHIJ'); assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(header + '.' + claims), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(auth.token(), first); time += 50 * 60_000; assert.notEqual(auth.token(), first);
});
test('APNs real HTTP2 adapter pins host, app topic, generic payload and exact provider receipt', async t => {
  const observed = {}, requestID = randomUUID(); const provider = new ApnsProvider({ authorization: { token: () => 'controlled-jwt' }, topic: 'com.lovelies.memories', environment: 'sandbox', sessionFactory: (origin, options) => { observed.origin = origin; observed.options = options; return fakeSession({ status: 200 }, observed); } }); t.after(() => provider.close());
  const prepared = await provider.prepare(input, requestID); assert.deepEqual(await provider.send(prepared), { status: 'accepted', provider_message_id: requestID });
  assert.equal(observed.origin, 'https://api.sandbox.push.apple.com'); assert.equal(observed.options.rejectUnauthorized, true); assert.equal(observed.headers['apns-topic'], 'com.lovelies.memories');
  assert.equal(observed.body.id, input.notification.id); assert.equal(observed.body.aps.alert.title, 'Lovelies'); assert.equal(observed.headers['apns-push-type'], 'alert');
});
test('APNs invalid-token rejection and mismatched success ID cannot become accepted', async t => {
  for (const [reply, expected] of [[{ status: 410, body: { reason: 'Unregistered' } }, 'rejected'], [{ status: 200, id: randomUUID() }, 'ambiguous']]) {
    const provider = new ApnsProvider({ authorization: { token: () => 'controlled' }, topic: 'com.lovelies.memories', environment: 'production', sessionFactory: () => fakeSession(reply, {}) }); t.after(() => provider.close());
    const result = await provider.send(await provider.prepare(input, randomUUID())); assert.equal(result.status, expected); if (expected === 'rejected') assert.equal(result.token_invalid, true);
  }
});
test('APNs timeout rejects instead of silently retrying or claiming delivery', async t => {
  let connections = 0; const provider = new ApnsProvider({ authorization: { token: () => 'controlled' }, topic: 'com.lovelies.memories', environment: 'sandbox', timeoutMs: 10, sessionFactory: () => { connections++; return fakeSession(null, {}); } }); t.after(() => provider.close());
  // Keep a referenced timer because the production request deadline is unrefed.
  const alive = setTimeout(() => {}, 100); try { await assert.rejects(provider.send(await provider.prepare(input, randomUUID()))); } finally { clearTimeout(alive); }
  assert.equal(connections, 1);
});
test('FCM service account obtains a verified scoped JWT token and coalesces/refreshes OAuth cache', async () => {
  let calls = 0, time = Date.now(); const auth = new FcmAuthorization({ serviceAccount: account, projectID: account.project_id, now: () => time, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(options.redirect, 'manual');
    const jwt = options.body.get('assertion'), [header, payload, signature] = jwt.split('.'); const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.ok(verify('sha256', Buffer.from(header + '.' + payload), rsa.publicKey, Buffer.from(signature, 'base64url'))); assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging'); assert.equal(claims.aud, url); assert.equal(claims.exp - claims.iat, 3600);
    return Response.json({ access_token: 'controlled-oauth-token-' + calls, token_type: 'Bearer', expires_in: 3600 });
  } });
  assert.deepEqual(await Promise.all([auth.token(), auth.token(), auth.token()]), Array(3).fill('controlled-oauth-token-1')); assert.equal(calls, 1);
  time += 3550_000; assert.equal(await auth.token(), 'controlled-oauth-token-2'); assert.equal(calls, 2);
});
test('FCM wrong project/token URI and OAuth redirects are refused before dispatch', async () => {
  assert.throws(() => new FcmAuthorization({ serviceAccount: { ...account, token_uri: 'https://attacker.invalid' }, projectID: account.project_id }));
  assert.throws(() => new FcmAuthorization({ serviceAccount: account, projectID: 'other-project' }));
  const auth = new FcmAuthorization({ serviceAccount: account, projectID: account.project_id, fetcher: async () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid' } }) }); await assert.rejects(auth.token());
});
test('FCM pins HTTPv1 project/package, uses data-only native notification IDs and validates accepted names', async () => {
  let observed; const provider = new FcmProvider({ authorization: { token: async () => 'controlled-oauth' }, projectID: account.project_id, packageName: 'com.lovelies.memories', fetcher: async (url, options) => { observed = { url, options, body: JSON.parse(options.body) }; return Response.json({ name: 'projects/controlled-project/messages/controlled-message' }); } });
  const result = await provider.send(await provider.prepare(input)); assert.equal(result.status, 'accepted');
  assert.equal(observed.url, 'https://fcm.googleapis.com/v1/projects/controlled-project/messages:send'); assert.equal(observed.options.redirect, 'manual'); assert.equal(observed.body.message.data.id, input.notification.id);
  assert.equal(observed.body.message.android.restricted_package_name, 'com.lovelies.memories'); assert.equal(observed.body.message.notification, undefined);
});
test('FCM rejects unregistered tokens, refuses wrong-project successes and never follows redirects', async () => {
  for (const [response, expected] of [[Response.json({ error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 }), 'rejected'], [Response.json({ name: 'projects/other-project/messages/wrong' }), 'ambiguous']]) {
    const provider = new FcmProvider({ authorization: { token: async () => 'controlled-oauth' }, projectID: account.project_id, packageName: 'com.lovelies.memories', fetcher: async () => response });
    const result = await provider.send(await provider.prepare(input)); assert.equal(result.status, expected); if (expected === 'rejected') assert.equal(result.token_invalid, true);
  }
  const provider = new FcmProvider({ authorization: { token: async () => 'controlled-oauth' }, projectID: account.project_id, packageName: 'com.lovelies.memories', fetcher: async () => new Response('', { status: 302 }) }); await assert.rejects(provider.send(await provider.prepare(input)));
});
