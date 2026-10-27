import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonical, sha256 } from '../src/journal.mjs';
import { validateDescriptor as validateD1, validateLink as validateL1 } from '../src/inventory-values.mjs';
import { DESCRIPTOR_V2_LIMITS, validateUploadAuthorityV2, validateDescriptorV2, validateLinkV2, validateD2LinkTarget,
  canonicalOwnerActiveRoles, assertUploadAuthorityCurrent, parseDescriptorV2, parseLinkV2 } from '../src/inventory-descriptors-v2.mjs';
import { descriptor, authority, link, clone, id, current, NOW } from './inventory-descriptors-v2-fixtures.mjs';
import { validateDescriptor as frozenValidateD1, validateLink as frozenValidateL1 } from './fixtures/inventory-f2/inventory-values.mjs';
import { frozenF2SourceSHA256, legacyGoldenVectors } from './inventory-descriptors-v2-legacy.fixture.mjs';

const invalid = fn => assert.throws(fn, error => error.status === 400);
const changed = fn => assert.throws(fn, error => error.status === 409);
const bytes = v => new TextEncoder().encode(canonical(v)).byteLength;

for (const options of [{}, { minor: true }, { minor: true, differentGuardians: true }, { roles: ['admin', 'user'] }]) {
  test(`valid exact adult/guardian role proof ${JSON.stringify(options)}`, async () => {
    const { value, input } = descriptor(options), accepted = validateDescriptorV2(value, input), l = await link(value);
    assert.deepEqual(accepted, value); assert.deepEqual(validateUploadAuthorityV2(value.authority), value.authority);
    assert.deepEqual(await validateD2LinkTarget(l, value), l); assert.equal(assertUploadAuthorityCurrent(value.authority, clone(value.authority), current(value.authority)), true);
  });
}
test('returned descriptor/link/proof are fresh recursively frozen snapshots without caller aliasing', async () => {
  const { value } = descriptor({ minor: true }), accepted = validateDescriptorV2(value), l = await link(value), copy = validateLinkV2(l);
  value.authority.purpose_basis.photo_processing.guardian.approval.version++;
  l.verification.custom_metadata.source_version = 'different';
  assert.notDeepEqual(accepted.authority, value.authority); assert.notDeepEqual(copy.verification, l.verification);
  assert(Object.isFrozen(accepted.authority.purpose_basis.face_authentication.guardian.request));
  assert.throws(() => { copy.verification.byte_size = 100; }, TypeError);
});

const topNegatives = {
  version: d => { d.version = 1; }, extra: d => { d.token = 'SECRET'; }, missing: d => { delete d.writer_generation_id; },
  uuidCase: d => { d.owner_id = d.owner_id.replace('00000000', 'ABCDEFAB'); }, action: d => { d.action = 'delete'; },
  bucket: d => { d.bucket = 'PHOTOS'; }, kind: d => { d.kind = 'upload-chunk'; }, key: d => { d.object_key += '/other'; },
  keyTraversal: d => { d.object_key += '/../'; }, sourceSize: d => { d.payload.source_byte_size++; }, zeroSize: d => { d.payload.byte_size = d.payload.source_byte_size = 0; },
  maxSize: d => { d.payload.byte_size = d.payload.source_byte_size = DESCRIPTOR_V2_LIMITS.source + 1; }, mime: d => { d.payload.content_type = 'application/octet-stream'; },
  checksum: d => { d.payload.sha256 = 'A'.repeat(64); }, offset: d => { d.payload.offset_bytes = 0; }, transfer: d => { d.payload.transfer_sha256 = 'a'.repeat(64); },
  crossOwner: d => { d.authority.account.account_id = id(); }, rawPhoto: d => { d.payload.bytes = 'PRIVATE_PHOTO'; },
};
for (const [name, change] of Object.entries(topNegatives)) test(`D2 rejects ${name} without normalization`, () => {
  const { value } = descriptor(); change(value); const before = clone(value); invalid(() => validateDescriptorV2(value)); assert.deepEqual(value, before);
});
for (const field of ['operation_id', 'writer_generation_id', 'database_id', 'incarnation_id', 'write_id']) test(`D2 binds original admitted ${field}`, () => {
  const { value, input } = descriptor();
  if (field === 'database_id' || field === 'incarnation_id') input.expected[field] = id();
  else if (field === 'write_id') input.allocations.id_0 = id(); else input[field] = id();
  changed(() => validateDescriptorV2(value, input));
});
const proofNegatives = {
  protocol: a => { a.protocol = 'unknown'; }, rawJWK: a => { a.device.public_jwk = '{}'; }, rawTemplate: a => { a.profile.template_key = 'private'; },
  rawRefresh: a => { a.session.refresh_hash = 'private'; }, duplicateRoles: a => { a.account.active_roles = ['user', 'user']; },
  unsortedRoles: a => { a.account.active_roles = ['user', 'admin']; }, retiredActiveRole: a => { a.account.active_roles = ['photographer']; },
  epoch: a => { a.session.auth_epoch++; }, device: a => { a.session.device_id = id(); }, deviceRevision: a => { a.session.device_revision = 'different'; },
  profile: a => { a.session.face_profile_revision = 'different'; }, profileEpoch: a => { a.session.face_profile_epoch++; },
  authConsent: a => { a.session.face_consent_id = id(); }, consentPurpose: a => { a.processing_consent.purpose = 'photo_matching'; },
  consentOwner: a => { a.authentication_consent.account_id = id(); }, consentRevision: a => { a.authentication_consent.profile_revision = 'different'; },
  purposePolicy: a => { a.purpose_basis.face_authentication.policy_version = 'different'; }, audienceOwner: a => { a.audience.account_id = id(); },
  under13: a => { a.audience.age_band = 'under13'; }, audienceState: a => { a.audience.status = 'blocked'; },
  anonymous: a => { a.account.identity_state = 'anonymous'; }, unsafeVersion: a => { a.audience.version = Number.MAX_SAFE_INTEGER + 1; },
  invalidPolicy: a => { a.authentication_consent.policy_version = 'invalid\u0000'; }, expiresBeforeCreated: a => { a.session.expires_at = a.session.created_at; },
};
for (const [name, change] of Object.entries(proofNegatives)) test(`authority proof rejects ${name}`, () => {
  const a = authority(); change(a); invalid(() => validateUploadAuthorityV2(a));
});
const guardianNegatives = {
  missing: a => { a.purpose_basis.face_authentication.guardian = null; }, extraEvidence: a => { a.purpose_basis.photo_processing.guardian.request.evidence_reference = 'PRIVATE'; },
  wrongChild: a => { a.purpose_basis.face_authentication.guardian.approval.child_account_id = id(); },
  wrongGuardian: a => { a.purpose_basis.face_authentication.guardian.approval.guardian_account_id = id(); },
  wrongPurpose: a => { a.purpose_basis.face_authentication.guardian.approval.purpose = 'photo_processing'; },
  wrongRequest: a => { a.purpose_basis.face_authentication.guardian.approval.request_id = id(); },
  wrongChildVersion: a => { a.purpose_basis.face_authentication.guardian.request.child_audience_version++; },
  wrongGuardianVersion: a => { a.purpose_basis.face_authentication.guardian.approval.guardian_audience_version++; },
  childReviewer: a => { a.purpose_basis.face_authentication.guardian.request.reviewed_by = a.account.account_id; },
  guardianReviewer: a => { const g = a.purpose_basis.face_authentication.guardian; g.request.reviewed_by = g.account.account_id; },
  authPolicy: a => { a.purpose_basis.face_authentication.guardian.authentication_consent.policy_version = 'new-auth'; },
  guardianMinor: a => { a.purpose_basis.face_authentication.guardian.audience.age_band = '13_17'; },
  guardianProfile: a => { a.purpose_basis.face_authentication.guardian.profile.auth_consent_id = id(); },
  guardianConsentOwner: a => { a.purpose_basis.face_authentication.guardian.authentication_consent.account_id = a.account.account_id; },
  sameApproval: a => { a.purpose_basis.photo_processing.guardian.approval.id = a.purpose_basis.face_authentication.guardian.approval.id; },
  sameConsentDifferentAccount: a => { a.purpose_basis.photo_processing.guardian.authentication_consent.id = a.purpose_basis.face_authentication.guardian.authentication_consent.id;
    a.purpose_basis.photo_processing.guardian.profile.auth_consent_id = a.purpose_basis.face_authentication.guardian.authentication_consent.id; },
};
for (const [name, change] of Object.entries(guardianNegatives)) test(`two-purpose guardian proof rejects ${name}`, () => {
  const a = authority({ minor: true, differentGuardians: true }); change(a); invalid(() => validateUploadAuthorityV2(a));
});
test('same guardian repeated bases cannot conflict across purpose slots', () => {
  const a = authority({ minor: true }); a.purpose_basis.photo_processing.guardian.profile.revision = 'new'; invalid(() => validateUploadAuthorityV2(a));
});
test('historical parsing does not rewrite policy/expiry or impose unsupported consent expiry ordering', () => {
  const a = authority(); a.authentication_consent.created_at = 100000; a.authentication_consent.expires_at = 0;
  const result = validateUploadAuthorityV2(a); assert.deepEqual(result, a); changed(() => assertUploadAuthorityCurrent(a, clone(a), current(a)));
});
test('role comparison preserves exact active-set equivalence and ignores retired storage-only photographer', () => {
  assert.deepEqual(canonicalOwnerActiveRoles('["user","admin","photographer"]', ['admin', 'user']), ['admin', 'user']);
  const a = authority({ roles: ['admin', 'user'] }), state = current(a); state.stored_roles_json = '["user","photographer","admin"]'; state.credential_roles = ['user', 'admin'];
  assert.equal(assertUploadAuthorityCurrent(a, clone(a), state), true);
});
for (const roles of [['admin', 'user'], ['admin']]) test(`active role drift denies unchanged epochs (${roles.join(',')})`, () => {
  const a = authority(), next = clone(a); next.account.active_roles = roles;
  const state = current(next); state.credential_roles = ['user']; changed(() => assertUploadAuthorityCurrent(a, next, state));
});
for (const raw of ['[]', '["unknown"]', '["user","user"]', '["photographer"]', '{"user":true}', 'invalid']) test(`invalid current stored roles fail closed (${raw})`, () => {
  invalid(() => canonicalOwnerActiveRoles(raw, ['user']));
});
test('processing renewal C2 cannot substitute for original C1 while unchanged C1 remains valid', () => {
  const a = authority(), next = clone(a); next.processing_consent.id = id(); changed(() => assertUploadAuthorityCurrent(a, next, current(next)));
  assert.equal(assertUploadAuthorityCurrent(a, clone(a), current(a)), true);
});
for (const component of ['session', 'device', 'profile', 'authentication_consent', 'audience', 'guardian']) test(`current snapshot cannot substitute changed ${component} episode`, () => {
  const a = authority({ minor: true }), next = clone(a);
  if (component === 'session') next.session.id = id();
  if (component === 'device') { next.device.revision = 'changed'; next.session.device_revision = 'changed'; }
  if (component === 'profile') { next.profile.revision = 'changed'; next.session.face_profile_revision = 'changed'; }
  if (component === 'authentication_consent') { next.authentication_consent.id = id(); next.profile.auth_consent_id = next.authentication_consent.id; next.session.face_consent_id = next.authentication_consent.id; }
  if (component === 'audience') { next.audience.version++; for (const b of Object.values(next.purpose_basis)) b.guardian.request.child_audience_version++; }
  if (component === 'guardian') { const old = next.purpose_basis.face_authentication.guardian; old.approval.id = id(); }
  changed(() => assertUploadAuthorityCurrent(a, next, current(next)));
});
for (const component of ['session', 'processing', 'authentication', 'audience', 'guardianRequest', 'guardianApproval', 'guardianAuth']) test(`current ${component} expiry/policy is not historical authority`, () => {
  const a = authority({ minor: true }), state = current(a);
  if (component === 'session') a.session.expires_at = NOW;
  if (component === 'processing') a.processing_consent.expires_at = NOW;
  if (component === 'authentication') state.policies.authentication = 'new-policy';
  if (component === 'audience') a.audience.next_review_at = NOW;
  if (component === 'guardianRequest') for (const b of Object.values(a.purpose_basis)) b.guardian.request.expires_at = NOW;
  if (component === 'guardianApproval') a.purpose_basis.face_authentication.guardian.approval.expires_at = NOW;
  if (component === 'guardianAuth') for (const b of Object.values(a.purpose_basis)) b.guardian.authentication_consent.expires_at = NOW;
  changed(() => assertUploadAuthorityCurrent(a, clone(a), state));
});

const linkNegatives = {
  oldVersion: l => { l.version = 1; }, extra: l => { l.access_token = 'PRIVATE'; }, chunk: l => { l.relation = 'upload-chunk'; }, offset: l => { l.offset_bytes = 0; },
  weak: l => { l.verification.strong_etag = 'W/"weak"'; }, unquoted: l => { l.verification.strong_etag = 'not-raw-http'; }, missingVersion: l => { l.verification.storage_version = null; },
  fabricatedStatus: l => { l.verification.actual_put_status = null; }, failureStatus: l => { l.verification.actual_put_status = 503; },
  versionConflict: l => { l.verification.actual_put_version = 'different'; }, etagConflict: l => { l.verification.actual_put_etag = '"different"'; },
  metadataAsset: l => { l.verification.custom_metadata.asset_id = id(); }, metadataVersion: l => { l.verification.custom_metadata.source_version = 'different'; },
  metadataHash: l => { l.verification.custom_metadata.source_checksum_sha256 = 'c'.repeat(64); }, unknownProof: l => { l.verification.provider_terminal = true; },
  privateDiagnostic: l => { l.verification.secret = 'PRIVATE'; }, providerControl: l => { l.verification.storage_version = 'v\n1'; },
};
for (const [name, change] of Object.entries(linkNegatives)) test(`L2 rejects ${name}`, async () => {
  const { value } = descriptor(), l = await link(value); change(l); invalid(() => validateLinkV2(l));
});
for (const component of ['descriptorHash', 'authorityHash', 'generation', 'target', 'byteSize', 'actualBytesSha', 'mime', 'sameOperation']) test(`L2 cannot substitute ${component} against exact D2`, async () => {
  const { value } = descriptor(), l = await link(value);
  if (component === 'descriptorHash') l.target_descriptor_hash = 'c'.repeat(64);
  if (component === 'authorityHash') l.authority_episode_hash = 'c'.repeat(64);
  if (component === 'generation') l.writer_generation_id = id();
  if (component === 'target') { l.target_write_id = id(); l.verification.object_key = `source/${l.owner_id}/${l.asset_id}/${l.asset_version}/${l.target_write_id}`; }
  if (component === 'byteSize') l.verification.byte_size++;
  if (component === 'actualBytesSha') { l.verification.sha256 = 'c'.repeat(64); l.verification.custom_metadata.source_checksum_sha256 = l.verification.sha256; }
  if (component === 'mime') l.verification.content_type = 'image/png';
  if (component === 'sameOperation') l.operation_id = value.operation_id;
  await assert.rejects(() => validateD2LinkTarget(l, value), error => error.status === 409);
});
test('missing actual PUT ETag/version stay null rather than being fabricated from GET proof', async () => {
  const { value } = descriptor(), l = await link(value); l.verification.actual_put_etag = null; l.verification.actual_put_version = null;
  const accepted = await validateD2LinkTarget(l, value); assert.equal(accepted.verification.actual_put_etag, null); assert.equal(accepted.verification.actual_put_version, null);
});
test('link input binding is separate from target-registration identity', async () => {
  const { value, input } = descriptor(), l = await link(value), linkInput = { ...input, operation_id: l.operation_id };
  assert.deepEqual(validateLinkV2(l, linkInput), l); changed(() => validateLinkV2(l, input));
});
test('canonical byte parser rejects duplicate keys, whitespace, alternate numbers, invalid UTF8 and BOM', async () => {
  const { value } = descriptor(), text = canonical(value), l = await link(value);
  assert.deepEqual(parseDescriptorV2(new TextEncoder().encode(text)), value); assert.deepEqual(parseLinkV2(canonical(l)), l);
  for (const bad of [text + ' ', text.replace('"version":2', '"version":2,"version":2'), text.replace('"auth_epoch":1', '"auth_epoch":1e0'), '\ufeff' + text]) invalid(() => parseDescriptorV2(bad));
  invalid(() => parseDescriptorV2(new Uint8Array([0xc0, 0xaf])));
});
test('source byte boundary1 and20MiB succeeds, boundary+1 fails', () => {
  for (const count of [1, DESCRIPTOR_V2_LIMITS.source]) { const { value } = descriptor(); value.payload.byte_size = value.payload.source_byte_size = count; assert.equal(validateDescriptorV2(value).payload.byte_size, count); }
  const { value } = descriptor(); value.payload.byte_size = value.payload.source_byte_size = DESCRIPTOR_V2_LIMITS.source + 1; invalid(() => validateDescriptorV2(value));
});
test('typed long guardian proof remains bounded or refuses atomically without partial proof', () => {
  const { value } = descriptor({ minor: true, differentGuardians: true });
  const before = clone(value);
  assert(bytes(value) <= DESCRIPTOR_V2_LIMITS.descriptor); assert.deepEqual(validateDescriptorV2(value), before);
  const huge = ' '.repeat(DESCRIPTOR_V2_LIMITS.descriptor + 1);
  assert.throws(() => parseDescriptorV2(huge), error => error.status === 413); assert.deepEqual(value, before);
});
test('provider value length limit256 accepted;257 rejected without truncation', async () => {
  const { value } = descriptor(), l = await link(value); l.verification.storage_version = 'v'.repeat(256); l.verification.actual_put_version = null;
  assert.equal(validateLinkV2(l).verification.storage_version.length, 256); l.verification.storage_version += 'v'; invalid(() => validateLinkV2(l));
});
test('maximum allowed policy/revision/asset strings remain complete or fail the total descriptor byte ceiling atomically', () => {
  const { value } = descriptor({ minor: true, differentGuardians: true }), a = value.authority;
  const authPolicy = 'a'.repeat(128), photoPolicy = 'p'.repeat(128), audiencePolicy = 'u'.repeat(128), revision = 'r'.repeat(128);
  value.asset_version = 'V'.repeat(128); value.object_key = `source/${value.owner_id}/${value.asset_id}/${value.asset_version}/${value.write_id}`;
  a.profile.revision = a.session.face_profile_revision = revision; a.authentication_consent.profile_revision = revision;
  a.device.revision = a.session.device_revision = revision; a.authentication_consent.policy_version = authPolicy;
  a.processing_consent.policy_version = photoPolicy; a.audience.policy_version = audiencePolicy;
  for (const [purpose, basis] of Object.entries(a.purpose_basis)) {
    basis.policy_version = purpose === 'face_authentication' ? authPolicy : photoPolicy;
    const g = basis.guardian; g.authentication_consent.policy_version = authPolicy;
    g.profile.revision = g.authentication_consent.profile_revision = revision;
    g.audience.policy_version = g.request.policy_version = audiencePolicy; g.approval.policy_version = basis.policy_version;
  }
  const before = clone(value), size = bytes(value);
  if (size > DESCRIPTOR_V2_LIMITS.descriptor) assert.throws(() => validateDescriptorV2(value), error => error.status === 413);
  else assert.deepEqual(validateDescriptorV2(value), value);
  assert.deepEqual(value, before);
  // Field boundary+1 is malformed even if total bytes happen to remain small.
  value.asset_version += 'x'; invalid(() => validateDescriptorV2(value));
});
test('frozen f2 validator fixture has its exact original transitive module bytes', async () => {
  for (const [name, expected] of Object.entries(frozenF2SourceSHA256)) {
    const source = await readFile(new URL('./fixtures/inventory-f2/' + name, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, name);
  }
});
for (const vector of legacyGoldenVectors) test(`historical ${vector.kind} ${vector.name} retains golden canonical bytes/hash through old and current D1/L1 validators`, async () => {
  const value = JSON.parse(vector.canonical), before = clone(value);
  const oldValidator = vector.kind === 'descriptor' ? frozenValidateD1 : frozenValidateL1;
  const currentValidator = vector.kind === 'descriptor' ? validateD1 : validateL1;
  assert.equal(await sha256(vector.canonical), vector.sha256);
  const old = oldValidator(value), accepted = currentValidator(value);
  assert.deepEqual(old, before); assert.deepEqual(accepted, old); assert.deepEqual(value, before);
  assert.equal(canonical(old), vector.canonical); assert.equal(canonical(accepted), vector.canonical);
  assert.equal(await sha256(canonical(old)), vector.sha256); assert.equal(await sha256(canonical(accepted)), vector.sha256);
});
const legacyInvalidVectors = [
  { kind: 'descriptor', base: 'direct-source', name: 'extra', mutate: v => { v.extra = true; } },
  { kind: 'descriptor', base: 'direct-source', name: 'missing authority', mutate: v => { delete v.authority; } },
  { kind: 'descriptor', base: 'direct-source', name: 'new version', mutate: v => { v.version = 2; } },
  { kind: 'descriptor', base: 'direct-source', name: 'foreign project', mutate: v => { v.project_id = 'foreign'; } },
  { kind: 'descriptor', base: 'direct-source', name: 'wrong exact key', mutate: v => { v.object_key += '/new'; } },
  { kind: 'descriptor', base: 'direct-source', name: 'wrong purpose', mutate: v => { v.authority.purpose = 'photo_matching'; } },
  { kind: 'descriptor', base: 'direct-source', name: 'unsupported MIME', mutate: v => { v.payload.content_type = 'text/plain'; } },
  { kind: 'descriptor', base: 'upload-chunk', name: 'unaligned offset', mutate: v => { v.payload.offset_bytes++; } },
  { kind: 'descriptor', base: 'direct-source', name: 'old expiry ordering', mutate: v => { v.authority.consent_expires_at = v.authority.consent_created_at; } },
  { kind: 'descriptor', base: 'direct-source', name: 'direct transfer checksum', mutate: v => { v.payload.transfer_sha256 = v.payload.sha256; } },
  { kind: 'link', base: 'asset-source', name: 'D2 proof in L1', mutate: v => { v.authority_episode_hash = 'a'.repeat(64); } },
  { kind: 'link', base: 'asset-source', name: 'new version', mutate: v => { v.version = 2; } },
  { kind: 'link', base: 'asset-source', name: 'invalid target hash', mutate: v => { v.target_descriptor_hash = 'A'.repeat(64); } },
  { kind: 'link', base: 'asset-source', name: 'unknown key field', mutate: v => { v.object_key = 'private'; } },
  { kind: 'link', base: 'asset-source', name: 'unknown relation', mutate: v => { v.relation = 'unknown'; } },
  { kind: 'link', base: 'asset-source', name: 'offset on asset link', mutate: v => { v.offset_bytes = 0; } },
  { kind: 'link', base: 'upload-chunk', name: 'null chunk offset', mutate: v => { v.offset_bytes = null; } },
  { kind: 'link', base: 'asset-source', name: 'foreign project', mutate: v => { v.project_id = 'foreign'; } },
];
function legacyFailure(validator, value, input) {
  let error;
  try { validator(value, input); } catch (caught) { error = caught; }
  assert(error, 'Invalid historical vector must fail');
  return { status: error.status, code: error.code };
}
for (const vector of legacyInvalidVectors) test(`old/current historical ${vector.kind} rejection agrees: ${vector.name}`, () => {
  const golden = legacyGoldenVectors.find(x => x.kind === vector.kind && x.name === vector.base), value = JSON.parse(golden.canonical);
  vector.mutate(value); const before = clone(value), oldValidator = vector.kind === 'descriptor' ? frozenValidateD1 : frozenValidateL1;
  const currentValidator = vector.kind === 'descriptor' ? validateD1 : validateL1;
  const old = legacyFailure(oldValidator, value), actual = legacyFailure(currentValidator, value);
  assert.equal(old.status, 400); assert.deepEqual(actual, old); assert.deepEqual(value, before);
});
for (const field of ['descriptor.operation_id', 'descriptor.write_id', 'descriptor.database_id', 'descriptor.incarnation_id', 'descriptor.writer_generation_id',
  'link.operation_id', 'link.writer_generation_id']) test(`old/current historical binding agrees: ${field}`, () => {
  const [kind, binding] = field.split('.'), golden = legacyGoldenVectors.find(x => x.kind === kind), value = JSON.parse(golden.canonical);
  const originalDescriptor = JSON.parse(legacyGoldenVectors.find(x => x.kind === 'descriptor').canonical);
  const input = { operation_id: value.operation_id, writer_generation_id: value.writer_generation_id,
    allocations: { id_0: value.write_id ?? originalDescriptor.write_id }, expected: { database_id: value.database_id ?? originalDescriptor.database_id,
      incarnation_id: value.incarnation_id ?? originalDescriptor.incarnation_id } };
  const different = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
  if (binding === 'write_id') input.allocations.id_0 = different;
  else if (binding === 'database_id' || binding === 'incarnation_id') input.expected[binding] = different; else input[binding] = different;
  const old = legacyFailure(kind === 'descriptor' ? frozenValidateD1 : frozenValidateL1, value, input);
  const actual = legacyFailure(kind === 'descriptor' ? validateD1 : validateL1, value, input);
  assert.equal(old.status, 400); assert.deepEqual(actual, old);
});
test('complete D2/L2 cannot pass either frozen or current exact D1/L1 readers', async () => {
  const { value } = descriptor(), l2 = await link(value);
  for (const validator of [frozenValidateD1, validateD1]) invalid(() => validator(value));
  for (const validator of [frozenValidateL1, validateL1]) invalid(() => validator(l2));
});
