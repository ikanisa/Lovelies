import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
import { builtinModules } from 'node:module';

const entry = new URL('../src/index.ts', import.meta.url).pathname;
const instances = new Set();
const jsonResponse = (value, status = 200) => new RuntimeResponse(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
async function providerResponse(value) {
  if (value instanceof RuntimeResponse || value instanceof Response) {
    return new RuntimeResponse(await value.arrayBuffer(), { status: value.status, headers: value.headers });
  }
  return jsonResponse(value);
}
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(value))).toString('hex');
export const encode = value => Buffer.from(value).toString('base64url');
export const sign = async (key, payload) => encode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(stable(payload))));
export const fixturePng = (index = 0) => new Uint8Array(Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCk0AAAAASUVORK5CYII=', 'base64'),
  Buffer.from(`synthetic-test-capture-${index}`),
]));

export async function faceVerifierFixture(envelope, form) {
  for (const capture of envelope.capture_manifest) {
    const image = form.get(`capture_${capture.index}`);
    assert(image && typeof image.arrayBuffer === 'function');
    assert.equal(await sha256(await image.arrayBuffer()), capture.sha256);
    assert.equal(image.size, capture.byte_size);
  }
  const verdict = { ...envelope, verified_at: Date.now(), expires_at: envelope.expires_at,
    receipt_id: crypto.randomUUID().replaceAll('-', ''), identity_verified: true };
  if (envelope.reference_mode === 'first_registration') {
    const template = new TextEncoder().encode(`synthetic-template:${envelope.account_id}`);
    return { ...verdict, enrollment_verified: true,
      pose_evidence: envelope.capture_manifest.map((capture, index) => ({ index: capture.index,
        pose: envelope.poses[index], capture_sha256: capture.sha256, verified: true })), registered_reference: {
      revision: crypto.randomUUID(), model_id: 'face-model-fixture-v1',
      template_sha256: await sha256(template), template_base64: encode(template),
    } };
  }
  const reference = form.get('reference');
  assert(reference && typeof reference.arrayBuffer === 'function');
  assert.equal(await sha256(await reference.arrayBuffer()), envelope.reference_digest);
  return { ...verdict, reference_match: true };
}

export function deviceEnvelope(challenge) {
  return Object.fromEntries(['challenge_id','nonce','purpose','account_id','device_id','device_revision',
    'profile_id','profile_revision','policy_version'].map(key => [key, challenge[key]]).concat([['protocol', 'lovelies-face-device-v1']]));
}
export async function captureProofs(h, challenge, privateKey, { token, seed = crypto.randomUUID() } = {}) {
  const captureManifest = [];
  for (let index = 0; index < challenge.required_captures; index++) {
    const bytes = fixturePng(`${seed}:${index}`), sha256hex = await sha256(bytes), mime = 'image/png';
    const details = { ...deviceEnvelope(challenge), step: 'capture', capture_index: index,
      capture_sha256: sha256hex, mime, byte_size: bytes.byteLength };
    const signature = await sign(privateKey, details);
    await h.json(`/auth/face/proof/${challenge.challenge_id}/${index}`, {
      method: 'PUT', token, raw: bytes, headers: { 'content-type': mime,
        'x-lovelies-capture-sha256': sha256hex, 'x-lovelies-device-signature': signature,
        'x-lovelies-capture-bytes': String(bytes.byteLength) } });
    captureManifest.push({ index, sha256: sha256hex, mime, byte_size: bytes.byteLength });
  }
  return { challenge_id: challenge.challenge_id, device_signature: await sign(privateKey,
    { ...deviceEnvelope(challenge), step: 'complete', capture_manifest: captureManifest }) };
}
export async function prepareEnrollment(h) {
  const anonymous = await h.anonymous();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const challenge = await h.json('/auth/face/registration/challenge', { token: anonymous.access_token, body: {
    device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
    consent: { purpose: 'face_authentication', granted: true, policy_version: 'face-policy-fixture-v1' },
  } }, 201);
  const completion = await captureProofs(h, challenge, keys.privateKey, { token: anonymous.access_token });
  return { anonymous, keys, challenge, completion };
}
export async function enroll(h) {
  const prepared = await prepareEnrollment(h);
  const credentials = await h.json('/auth/face/registration/complete', {
    token: prepared.anonymous.access_token, body: prepared.completion });
  assert.equal(credentials.account_id, prepared.anonymous.account_id);
  assert.equal(credentials.auth_method, 'registered_face');
  return { ...credentials, ...prepared, token: credentials.access_token, accountId: credentials.account_id,
    faceHandle: prepared.challenge.face_handle, deviceId: prepared.challenge.device_id };
}

/** Real workerd + SQLite DO + R2 + Queues. Private model fixtures prove protocol
 * and authority behavior only; they do not establish face/model qualification. */
export async function startHarness({ faceVerifier, photoProcessor, storeVerifier, pushService, privateMlWorker, mediaWriteGate, vars = {}, consumeQueue = true } = {}) {
  const fixtureSecret = crypto.randomUUID();
  // Test-only authority RPC avoids a deadlocking inspector API in the pinned
  // Miniflare build with Node-backed service fixtures. Neither this subclass nor
  // this route exists in src/index.ts or in the Wrangler application bundle.
  const harnessEntry = `import application,{LoveliesCore as Authority} from ${JSON.stringify(entry)};
    export class LoveliesCore extends Authority {
      constructor(state,env) {
        const selected=env.RUNTIME_MEDIA_GATE?{...env,QUARANTINE:new Proxy(env.QUARANTINE,{get(target,name){
          if(name==='put')return async(key,...args)=>{
            const gate=async(stage)=>{const result=await env.RUNTIME_MEDIA_GATE.fetch(new Request('https://fixture.invalid/write',{
              method:'POST',body:JSON.stringify({key,stage})}));if(!result.ok)throw new Error('fixture_storage_reply_lost');};
            await gate('before');const result=await target.put(key,...args);await gate('after');return result;
          };
          const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
        }})}:env;
        super(state,selected);
      }
      fixtureSql(query,bindings) { return this.app.db.all(query,...bindings); }
      fixtureAlarm() { return this.alarm(); }
    }
    export default {...application,async fetch(request,env,ctx) {
      if(new URL(request.url).pathname==='/_fixture/alarm' && request.headers.get('x-fixture-secret')===env.RUNTIME_FIXTURE_SECRET) {
        await env.LOVELIES_CORE.get(env.LOVELIES_CORE.idFromName('lovelies-core-v1')).fixtureAlarm();
        return Response.json({status:'completed'});
      }
      if(new URL(request.url).pathname==='/_fixture/sql' && request.headers.get('x-fixture-secret')===env.RUNTIME_FIXTURE_SECRET) {
        const {query,bindings}=await request.json();
        try { return Response.json(await env.LOVELIES_CORE.get(env.LOVELIES_CORE.idFromName('lovelies-core-v1')).fixtureSql(query,bindings)); }
        catch(error) { return Response.json({error:String(error.message)},{status:500}); }
      }
      return application.fetch(request,env,ctx);
    }};`;
  const bundle = await build({ stdin: { contents: harnessEntry, resolveDir: new URL('../src', import.meta.url).pathname,
      sourcefile: 'private-runtime-fixture.mjs' }, write: false, bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', external: ['cloudflare:workers',...builtinModules.flatMap(name=>[name,`node:${name}`])], logLevel: 'silent' });
  const services = {};
  if(mediaWriteGate)services.RUNTIME_MEDIA_GATE=async request=>providerResponse(await mediaWriteGate(await request.json()));
  if (faceVerifier) services.FACE_AUTH_VERIFIER = async request => {
    const form = await request.formData();
    const envelope = JSON.parse(String(form.get('envelope')));
    return providerResponse(await faceVerifier(envelope, form));
  };
  if (photoProcessor) services.PHOTO_PROCESSOR = async request => providerResponse(await photoProcessor(await request.json()));
  if (storeVerifier) services.STORE_VERIFIER = async request => providerResponse(await storeVerifier(await request.json(),new URL(request.url).pathname));
  if (pushService) services.PUSH_SERVICE = async request => providerResponse(await pushService(request));
  if (privateMlWorker) {
    services.FACE_AUTH_VERIFIER = { name: privateMlWorker.name, entrypoint: 'FaceVerifier' };
    services.PHOTO_PROCESSOR = { name: privateMlWorker.name, entrypoint: 'PhotoProcessor' };
  }
  const coreOptions = { name: 'lovelies-runtime-test', script: bundle.outputFiles[0].text,
    modules: true, compatibilityDate: '2026-07-21', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { LOVELIES_CORE: { className: 'LoveliesCore', useSQLite: true } },
    r2Buckets: { PHOTOS: 'PHOTOS', QUARANTINE: 'QUARANTINE', PRIVACY_EXPORTS: 'PRIVACY_EXPORTS' },
    queueProducers: { PHOTO_JOBS: 'lovelies-test-jobs' },
    ...(consumeQueue ? { queueConsumers: { 'lovelies-test-jobs': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } } } : {}),
    bindings: { APP_ENV: 'test', AUTH_SIGNING_SECRET: 'local-fixture-only-auth-key-32-characters',
      MEDIA_SIGNING_SECRET: 'local-fixture-only-media-key-32-characters',
      FACE_AUTH_POLICY_VERSION: 'face-policy-fixture-v1', PHOTO_CONSENT_POLICY_VERSION: 'photo-policy-fixture-v1', PHOTO_MODEL_VERSION: 'face-model-fixture-v1',
      ALLOWED_ORIGINS: 'http://127.0.0.1:8765', PUBLIC_APP_BASE_URL: 'http://127.0.0.1:8765', ...vars,
      RUNTIME_FIXTURE_SECRET: fixtureSecret },
    serviceBindings: services,
  };
  const mf = new Miniflare(privateMlWorker ? { workers: [coreOptions,privateMlWorker] } : coreOptions);
  instances.add(mf);
  try {
  await mf.ready;
  const request = (path, { token, body, raw, method = body === undefined && raw === undefined ? 'GET' : 'POST', headers = {} } = {}) =>
    mf.dispatchFetch(`http://localhost${path}`, { method, signal: AbortSignal.timeout(10_000), headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? raw === undefined ? {} : { body: raw } : { body: JSON.stringify(body) }) });
  const json = async (path, options = {}, expected = 200) => {
    const response = await request(path, options); const value = await response.json();
    assert.equal(response.status, expected, `${options.method ?? 'request'} ${path}: ${value?.error?.code ?? value?.status ?? 'unexpected_response'}`);
    return value;
  };
  const storage = { exec: async (...args) => {
    const [query, ...bindings] = args;
    const response = await mf.dispatchFetch('http://localhost/_fixture/sql', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-secret': fixtureSecret },
      body: JSON.stringify({ query, bindings }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'fixture_sql_failed');
    return value;
  } };
  const anonymous = () => json('/auth/anonymous', { body: {} }, 201);
  return { mf, request, json, storage, anonymous,
    alarm: async () => { const response = await mf.dispatchFetch('http://localhost/_fixture/alarm', {method:'POST',headers:{'x-fixture-secret':fixtureSecret}}); assert.equal(response.status,200); },
    community: (token, action, payload, expected = 200) => json('/community/action', { token, body: { action, payload } }, expected),
    close: async () => { instances.delete(mf); await mf.dispose(); } };
  } catch (error) {
    instances.delete(mf); await mf.dispose(); throw error;
  }
}
export async function closeHarnesses() {
  await Promise.all([...instances].map(mf => mf.dispose())); instances.clear();
}
