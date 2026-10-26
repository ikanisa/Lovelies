import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresDatabase,connectPostgres} from '../src/database.ts';
import {isolatedPostgres} from './postgres-harness.mjs';
import {createApp,createHandler} from '../src/index.ts';
import {PostgresJobQueue,drainJobs,maintain} from '../src/jobs.ts';
import {INFERENCE_ENGINE_SPACE} from '../src/inference-contract.ts';
import {encodeGeneration} from '../src/inference-generation.ts';

export const fixtureInferenceGeneration=encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,
  engine_artifact_sha256:'a'.repeat(64),processing_fingerprint:'b'.repeat(64)});

const instances=new Set();
const numberRows=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])));
export class MemoryBucket {
  rows=new Map();
  constructor(gate){this.gate=gate;}
  async put(key,value,options={}){
    const checkGate=async stage=>{const reply=await this.gate?.({key,stage});if(reply instanceof Response&&!reply.ok){await reply.body?.cancel();throw new Error('synthetic_storage_reply_lost');}};
    await checkGate('before');
    const data=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);
    this.rows.set(key,{data:new Uint8Array(data),metadata:options.customMetadata??{},http:options.httpMetadata??{},etag:crypto.randomUUID()});
    await checkGate('after');
  }
  async head(key){const row=this.rows.get(key);return row?{key,size:row.data.length,etag:row.etag,customMetadata:row.metadata,httpMetadata:row.http}:null;}
  async get(key){const head=await this.head(key);if(!head)return null;const response=new Response(new Uint8Array(this.rows.get(key).data));return {...head,body:response.body,arrayBuffer:()=>response.arrayBuffer()};}
  async delete(key){for(const item of typeof key==='string'?[key]:key)this.rows.delete(item);}
  async list(){return {objects:await Promise.all([...this.rows.keys()].map(key=>this.head(key))),truncated:false};}
}
export async function startHarness({faceVerifier,photoProcessor,storeVerifier,pushService,mediaWriteGate,buckets,vars={},consumeQueue=true}={}){
  const localDatabase=process.env.TEST_DATABASE_URL?await isolatedPostgres(process.env.TEST_DATABASE_URL):null;
  const engine=localDatabase?.engine??await PGlite.create();
  try{
    if(!localDatabase)await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    const migrations=fs.readdirSync(new URL('../../../supabase/migrations/',import.meta.url)).filter(x=>/_lovelies_private_core\.sql$|_refresh_delivery\.sql$|_audience_retention\.sql$|_inference_generation\.sql$|_retention_scan_cursors\.sql$|_restore_control\.sql$/.test(x)).sort();
    for(const migration of migrations)await engine.exec(fs.readFileSync(new URL('../../../supabase/migrations/'+migration,import.meta.url),'utf8'));
  }catch(error){
    if(localDatabase)try{await engine.close();}catch(cleanupError){try{if(error instanceof Error&&Object.isExtensible(error))Object.defineProperty(error,'cleanupErrors',{value:[cleanupError],configurable:true});}catch{}}
    throw error;
  }
  // PGlite embeds PostgreSQL itself but has no multiple backend processes. The
  // test harness serializes connections and substitutes its unsupported lock
  // function. Hosted/multi-connection advisory-lock qualification stays open.
  let tail=Promise.resolve();
  const query=async(sql,values)=>{
    if(sql.startsWith('SELECT pg_advisory_xact_lock('))return [];
    return numberRows((await engine.query(sql,values)).rows);
  };
  const connection={query,begin:callback=>{
    const operation=tail.then(async()=>{await engine.exec('BEGIN');try{const value=await callback({query,begin:()=>{throw new Error('nested raw connection');}});await engine.exec('COMMIT');return value;}catch(error){await engine.exec('ROLLBACK');throw error;}});
    tail=operation.catch(()=>{});return operation;
  }};
  const db=localDatabase?connectPostgres(localDatabase.url):new PostgresDatabase(connection);
  const env={INFERENCE_ENGINE_IDENTITY:fixtureInferenceGeneration,APP_ENV:'test',AUTH_SIGNING_SECRET:'local-fixture-only-auth-key-32-characters',MEDIA_SIGNING_SECRET:'local-fixture-only-media-key-32-characters',INTERNAL_MAINTENANCE_SECRET:'local-fixture-only-maintenance-key-32-characters',FACE_AUTH_POLICY_VERSION:'face-policy-fixture-v1',PHOTO_MODEL_VERSION:'face-model-fixture-v1',PHOTO_CONSENT_POLICY_VERSION:'photo-policy-fixture-v1',PUBLIC_API_BASE_URL:'http://localhost/functions/v1/lovelies-api',ALLOWED_ORIGINS:'http://127.0.0.1:8765',PUBLIC_APP_BASE_URL:'http://127.0.0.1:8765',...vars,
    PHOTOS:buckets?.PHOTOS??new MemoryBucket(),QUARANTINE:buckets?.QUARANTINE??new MemoryBucket(mediaWriteGate),PRIVACY_EXPORTS:buckets?.PRIVACY_EXPORTS??new MemoryBucket(),PHOTO_JOBS:new PostgresJobQueue(db)};
  const response=value=>value instanceof Response?value:Response.json(value);
  if(faceVerifier)env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return response(await faceVerifier(JSON.parse(String(form.get('envelope'))),form));}};
  if(photoProcessor)env.PHOTO_PROCESSOR={fetch:async request=>response(await photoProcessor(await request.json()))};
  if(storeVerifier)env.STORE_VERIFIER={fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);return response(await storeVerifier(await request.json(),new URL(request.url).pathname));}};
  if(pushService)env.PUSH_SERVICE={fetch:async(input,init)=>response(await pushService(input instanceof Request?input:new Request(input,init)))};
  const app=createApp(db,env),handler=createHandler(app);
  const pendingJobs=new Set();
  const scheduleJobs=()=>{const operation=drainJobs(app).finally(()=>pendingJobs.delete(operation));pendingJobs.add(operation);void operation.catch(()=>{});};
  const request=async(path,{token,body,raw,method=body===undefined&&raw===undefined?'GET':'POST',headers={}}={})=>{
    const url=path.startsWith('http')?path:'http://localhost'+path;
    const result=await handler(new Request(url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{}),...headers},...(body===undefined?raw===undefined?{}:{body:raw}:{body:JSON.stringify(body)})}));
    if(consumeQueue)scheduleJobs();
    return result;
  };
  const json=async(path,options={},expected=200)=>{const res=await request(path,options),value=await res.json();assert.equal(res.status,expected,`${options.method??'request'} ${path}: ${value?.error?.code??value?.status??'unexpected_response'}`);return value;};
  // Fixture setup/corruption is an explicit write transaction. Production
  // automatic all()/one() are PostgreSQL READ ONLY, including SELECT functions.
  const harness={engine,db,app,env,request,json,databaseUrl:localDatabase?.url,storage:{exec:(sql,...bindings)=>db.transaction(()=>db.all(sql,...bindings))},anonymous:async({adult=false}={})=>{const guest=await json('/auth/anonymous',{body:{}},201);if(adult)await json('/me/audience',{token:guest.access_token,method:'PUT',body:{age_band:'18_plus',policy_version:'audience-2026-10-24-v1',expected_version:0,operation_key:crypto.randomUUID()}});return guest;},community:(token,action,payload={},expected=200)=>json('/community/action',{token,body:{action,payload}},expected),alarm:()=>maintain(app),mf:{getR2Bucket:async name=>env[name]},close:async()=>{instances.delete(harness);await Promise.allSettled([...pendingJobs]);await tail;await db.close?.();await engine.close();}};
  instances.add(harness);return harness;
}
export async function closeHarnesses(){await Promise.all([...instances].map(h=>h.close()));}

// Capture/signature helpers reused from the active native wire contract.
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
  const anonymous = await h.anonymous({adult:true});
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

