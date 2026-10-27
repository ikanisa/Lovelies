/** Pure D2/L2 codecs and association checks only. No routes, DB, provider or
 * credential authority. D1/L1 validators and historical hashes stay separate. */
import { PROJECT_ID, canonical, sha256, exact, plain, fail, uuidPattern, hashPattern } from './journal.mjs';

export const DESCRIPTOR_V2_LIMITS = Object.freeze({ descriptor: 8192, link: 4096, verification: 2048,
  registration: 10240, source: 20971520, policy: 128, version: 128, objectKey: 512, providerValue: 256 });
const fields = Object.freeze({
  account: ['account_id', 'auth_epoch', 'identity_state', 'active_roles'],
  guardianAccount: ['account_id', 'auth_epoch', 'identity_state'],
  session: ['id', 'account_id', 'auth_method', 'auth_epoch', 'created_at', 'expires_at', 'refresh_expires_at',
    'face_profile_revision', 'face_profile_epoch', 'face_consent_id', 'device_id', 'device_revision'],
  device: ['id', 'account_id', 'revision', 'created_at'],
  profile: ['id', 'account_id', 'revision', 'auth_epoch', 'auth_consent_id'],
  consent: ['id', 'account_id', 'purpose', 'policy_version', 'created_at', 'expires_at', 'profile_revision'],
  audience: ['account_id', 'age_band', 'status', 'version', 'policy_version', 'declared_at', 'next_review_at'],
  approval: ['id', 'request_id', 'child_account_id', 'guardian_account_id', 'purpose', 'policy_version',
    'version', 'created_at', 'expires_at', 'guardian_audience_version'],
  request: ['id', 'child_account_id', 'guardian_account_id', 'child_audience_version', 'policy_version',
    'revision', 'created_at', 'expires_at', 'reviewed_by', 'reviewed_at'],
});
const encoder = new TextEncoder();
const uuid = v => typeof v === 'string' && uuidPattern.test(v);
const hash = v => typeof v === 'string' && hashPattern.test(v);
const time = v => Number.isSafeInteger(v) && v >= 0;
const positive = v => Number.isSafeInteger(v) && v > 0;
const opaque = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const policy = v => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
const provider = v => typeof v === 'string' && /^[\x20-\x7e]{1,256}$/.test(v);
const strongETag = v => typeof v === 'string' && /^"[\x21\x23-\x7e]{1,254}"$/.test(v);
const equal = (a, b) => canonical(a) === canonical(b);
const invalid = () => fail(400, 'inventory_descriptor_v2_invalid');
const conflict = () => fail(409, 'inventory_descriptor_v2_binding_conflict');
const valid = condition => { if (!condition) invalid(); };
function bound(value, maximum) {
  if (encoder.encode(canonical(value)).byteLength > maximum) fail(413, 'inventory_descriptor_v2_too_large');
}
function frozenCopy(value) {
  const copy = JSON.parse(canonical(value));
  const freeze = x => { if (x && typeof x === 'object') { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } return x; };
  return freeze(copy);
}
function roles(value, canonicalOrder = true) {
  valid(Array.isArray(value) && value.length >= 1 && value.length <= 2 && new Set(value).size === value.length &&
    value.every(v => v === 'user' || v === 'admin'));
  const sorted = [...value].sort(); if (canonicalOrder) valid(equal(sorted, value)); return sorted;
}
/** Matches current accountRoles/sameRoles semantics; storage may retain ignored
 * photographer, credentials may not. This function never mints credentials. */
export function canonicalOwnerActiveRoles(storedRolesJson, credentialRoles) {
  valid(typeof storedRolesJson === 'string');
  if (encoder.encode(storedRolesJson).byteLength > 2048) fail(413, 'inventory_descriptor_v2_too_large');
  let stored; try { stored = JSON.parse(storedRolesJson); } catch { invalid(); }
  valid(typeof storedRolesJson === 'string' && Array.isArray(stored) && stored.length >= 1 && stored.length <= 3 &&
    new Set(stored).size === stored.length && stored.every(v => ['user', 'admin', 'photographer'].includes(v)));
  const active = roles(stored.filter(v => v !== 'photographer'), false), credential = roles(credentialRoles, false);
  if (!equal(active, credential)) conflict(); return Object.freeze(active);
}
function account(value, owner, guardian = false) {
  valid(exact(value, guardian ? fields.guardianAccount : fields.account) && uuid(value.account_id) &&
    value.account_id === owner && positive(value.auth_epoch) && value.identity_state === 'registered_face');
  if (!guardian) roles(value.active_roles);
}
function consent(value, owner, purpose) {
  valid(exact(value, fields.consent) && uuid(value.id) && value.account_id === owner && uuid(value.account_id) &&
    value.purpose === purpose && policy(value.policy_version) && time(value.created_at) &&
    (value.expires_at === null || time(value.expires_at)) && (value.profile_revision === null || opaque(value.profile_revision)));
  // The current schema does not order consent expiry after created_at. Historical
  // parsing must not add that unsupported rule; current expiry is separate.
}
function audience(value, owner, adult = false) {
  valid(exact(value, fields.audience) && value.account_id === owner && uuid(value.account_id) &&
    (adult ? value.age_band === '18_plus' : ['18_plus', '13_17'].includes(value.age_band)) && value.status === 'eligible' &&
    positive(value.version) && policy(value.policy_version) && time(value.declared_at) &&
    (value.next_review_at === null || time(value.next_review_at)));
}
function profile(value, owner, authConsent) {
  valid(exact(value, fields.profile) && uuid(value.id) && value.account_id === owner && uuid(value.account_id) &&
    opaque(value.revision) && positive(value.auth_epoch) && uuid(value.auth_consent_id) && value.auth_consent_id === authConsent.id &&
    (authConsent.profile_revision === null || authConsent.profile_revision === value.revision));
}
function guardian(bundle, child, purpose, ownerAudience, purposePolicy) {
  valid(exact(bundle, ['account', 'audience', 'profile', 'authentication_consent', 'request', 'approval']));
  const g = bundle.account?.account_id;
  valid(uuid(g) && g !== child); account(bundle.account, g, true); audience(bundle.audience, g, true);
  consent(bundle.authentication_consent, g, 'face_authentication'); profile(bundle.profile, g, bundle.authentication_consent);
  const r = bundle.request, p = bundle.approval;
  valid(exact(r, fields.request) && uuid(r.id) && r.child_account_id === child && r.guardian_account_id === g &&
    r.child_audience_version === ownerAudience.version && policy(r.policy_version) && r.policy_version === ownerAudience.policy_version &&
    positive(r.revision) && time(r.created_at) && time(r.expires_at) && uuid(r.reviewed_by) &&
    r.reviewed_by !== child && r.reviewed_by !== g && time(r.reviewed_at));
  valid(exact(p, fields.approval) && uuid(p.id) && p.request_id === r.id && p.child_account_id === child && p.guardian_account_id === g &&
    p.purpose === purpose && p.policy_version === purposePolicy && positive(p.version) && time(p.created_at) && time(p.expires_at) &&
    p.guardian_audience_version === bundle.audience.version && positive(p.guardian_audience_version));
  valid(bundle.audience.policy_version === ownerAudience.policy_version);
}
export function validateUploadAuthorityV2(value) {
  valid(exact(value, ['protocol', 'account', 'session', 'device', 'profile', 'authentication_consent', 'processing_consent', 'audience', 'purpose_basis']) &&
    value.protocol === 'lovelies-upload-authority-v2');
  const owner = value.account?.account_id; valid(uuid(owner)); account(value.account, owner);
  consent(value.authentication_consent, owner, 'face_authentication'); consent(value.processing_consent, owner, 'photo_processing');
  profile(value.profile, owner, value.authentication_consent); audience(value.audience, owner);
  const s = value.session, d = value.device;
  valid(exact(d, fields.device) && uuid(d.id) && d.account_id === owner && opaque(d.revision) && time(d.created_at));
  valid(exact(s, fields.session) && uuid(s.id) && s.account_id === owner && s.auth_method === 'registered_face' &&
    s.auth_epoch === value.account.auth_epoch && positive(s.auth_epoch) && time(s.created_at) && time(s.expires_at) &&
    s.expires_at > s.created_at && time(s.refresh_expires_at) && s.refresh_expires_at >= s.expires_at &&
    s.face_profile_revision === value.profile.revision && s.face_profile_epoch === value.profile.auth_epoch &&
    s.face_consent_id === value.authentication_consent.id && s.device_id === d.id && s.device_revision === d.revision);
  valid(exact(value.purpose_basis, ['face_authentication', 'photo_processing']));
  const ids = new Map(), requests = new Map();
  for (const purpose of ['face_authentication', 'photo_processing']) {
    const basis = value.purpose_basis[purpose], selected = purpose === 'face_authentication' ? value.authentication_consent : value.processing_consent;
    valid(exact(basis, ['purpose', 'policy_version', 'guardian']) && basis.purpose === purpose && basis.policy_version === selected.policy_version);
    if (value.audience.age_band === '18_plus') valid(basis.guardian === null);
    else {
      guardian(basis.guardian, owner, purpose, value.audience, basis.policy_version);
      const g = basis.guardian;
      valid(g.authentication_consent.policy_version === value.authentication_consent.policy_version);
      // Two slots may share guardian/request, but not disagree about the same
      // retained episode or reuse one approval ID for different purposes.
      const common = { account: g.account, audience: g.audience, profile: g.profile, authentication_consent: g.authentication_consent };
      if (ids.has(g.account.account_id)) valid(equal(ids.get(g.account.account_id), common)); else ids.set(g.account.account_id, common);
      if (requests.has(g.request.id)) valid(equal(requests.get(g.request.id), g.request)); else requests.set(g.request.id, g.request);
    }
  }
  const a = value.purpose_basis.face_authentication.guardian, p = value.purpose_basis.photo_processing.guardian;
  if (a && p) valid(a.approval.id !== p.approval.id);
  // Primary-key identity cannot denote conflicting accounts/episodes in the
  // same proof, even when duplicate nested references are structurally valid.
  const known = { consent: new Map(), profile: new Map() };
  const remember = (kind, item) => {
    if (known[kind].has(item.id)) valid(equal(known[kind].get(item.id), item)); else known[kind].set(item.id, item);
  };
  remember('consent', value.authentication_consent); remember('consent', value.processing_consent); remember('profile', value.profile);
  for (const basis of Object.values(value.purpose_basis)) if (basis.guardian) {
    remember('consent', basis.guardian.authentication_consent); remember('profile', basis.guardian.profile);
  }
  bound(value, DESCRIPTOR_V2_LIMITS.descriptor); return frozenCopy(value);
}
function inputBinding(value, input, allocated) {
  if (input === undefined) return;
  valid(plain(input) && input.version === 2 && input.project_id === PROJECT_ID && uuid(input.operation_id) &&
    uuid(input.writer_generation_id) && plain(input.expected) && uuid(input.expected.database_id) && uuid(input.expected.incarnation_id) &&
    (!allocated || plain(input.allocations) && uuid(input.allocations.id_0)));
  if (value.operation_id !== input.operation_id || value.writer_generation_id !== input.writer_generation_id ||
      allocated && (value.write_id !== input.allocations.id_0 || value.database_id !== input.expected.database_id ||
        value.incarnation_id !== input.expected.incarnation_id)) conflict();
}
export function validateDescriptorV2(value, input) {
  valid(exact(value, ['version', 'project_id', 'operation_id', 'write_id', 'database_id', 'incarnation_id', 'writer_generation_id',
    'action', 'kind', 'owner_id', 'asset_id', 'asset_version', 'bucket', 'object_key', 'authority', 'payload']) && value.version === 2 &&
    value.project_id === PROJECT_ID && ['operation_id', 'write_id', 'database_id', 'incarnation_id', 'writer_generation_id', 'owner_id', 'asset_id'].every(k => uuid(value[k])) &&
    opaque(value.asset_version) && value.bucket === 'QUARANTINE' && value.action === 'put' && value.kind === 'direct-source' &&
    value.object_key === `source/${value.owner_id}/${value.asset_id}/${value.asset_version}/${value.write_id}`);
  inputBinding(value, input, true);
  const authority = validateUploadAuthorityV2(value.authority), p = value.payload;
  valid(authority.account.account_id === value.owner_id && exact(p, ['byte_size', 'sha256', 'content_type', 'source_byte_size', 'offset_bytes', 'transfer_sha256']) &&
    positive(p.byte_size) && p.byte_size <= DESCRIPTOR_V2_LIMITS.source && hash(p.sha256) && ['image/jpeg', 'image/png', 'image/webp'].includes(p.content_type) &&
    p.source_byte_size === p.byte_size && p.offset_bytes === null && p.transfer_sha256 === null);
  bound(value, DESCRIPTOR_V2_LIMITS.descriptor); return frozenCopy(value);
}
function verification(value) {
  valid(exact(value, ['protocol', 'verification_id', 'bucket', 'object_key', 'storage_version', 'strong_etag', 'byte_size', 'sha256',
    'content_type', 'custom_metadata', 'actual_put_status', 'actual_put_etag', 'actual_put_version', 'read_completed_at']) &&
    value.protocol === 'lovelies-object-verification-v1' && uuid(value.verification_id) && value.bucket === 'QUARANTINE' &&
    typeof value.object_key === 'string' && value.object_key.length <= DESCRIPTOR_V2_LIMITS.objectKey &&
    /^source\/[A-Za-z0-9_/-]+$/.test(value.object_key) && !value.object_key.split('/').some(x => !x || x === '.' || x === '..') &&
    provider(value.storage_version) && strongETag(value.strong_etag) && positive(value.byte_size) && value.byte_size <= DESCRIPTOR_V2_LIMITS.source &&
    hash(value.sha256) && ['image/jpeg', 'image/png', 'image/webp'].includes(value.content_type) &&
    exact(value.custom_metadata, ['asset_id', 'source_version', 'source_checksum_sha256']) && uuid(value.custom_metadata.asset_id) &&
    opaque(value.custom_metadata.source_version) && hash(value.custom_metadata.source_checksum_sha256) &&
    Number.isInteger(value.actual_put_status) && value.actual_put_status >= 200 && value.actual_put_status <= 299 &&
    (value.actual_put_etag === null || provider(value.actual_put_etag)) && (value.actual_put_version === null || provider(value.actual_put_version)) && time(value.read_completed_at));
  if (value.actual_put_version !== null) valid(value.actual_put_version === value.storage_version);
  if (value.actual_put_etag !== null && strongETag(value.actual_put_etag)) valid(value.actual_put_etag === value.strong_etag);
  bound(value, DESCRIPTOR_V2_LIMITS.verification);
}
export function validateLinkV2(value, input) {
  valid(exact(value, ['version', 'project_id', 'operation_id', 'writer_generation_id', 'owner_id', 'asset_id', 'asset_version', 'target_write_id',
    'target_descriptor_hash', 'relation', 'offset_bytes', 'authority_episode_hash', 'verification']) && value.version === 2 && value.project_id === PROJECT_ID &&
    ['operation_id', 'writer_generation_id', 'owner_id', 'asset_id', 'target_write_id'].every(k => uuid(value[k])) && opaque(value.asset_version) &&
    hash(value.target_descriptor_hash) && hash(value.authority_episode_hash) && value.relation === 'asset-source' && value.offset_bytes === null);
  inputBinding(value, input, false); verification(value.verification);
  const v = value.verification;
  valid(v.object_key === `source/${value.owner_id}/${value.asset_id}/${value.asset_version}/${value.target_write_id}` &&
    v.custom_metadata.asset_id === value.asset_id && v.custom_metadata.source_version === value.asset_version && v.custom_metadata.source_checksum_sha256 === v.sha256);
  bound(value, DESCRIPTOR_V2_LIMITS.link); return frozenCopy(value);
}
/** Cross-binding only. Caller must separately prove exact committed target,
 * current capability/authority, no retirement, and actual provider observation. */
export async function validateD2LinkTarget(rawLink, rawDescriptor, options = {}) {
  const link = validateLinkV2(rawLink), descriptor = validateDescriptorV2(rawDescriptor), hashValue = options.hash ?? sha256;
  const [descriptorHash, authorityHash] = await Promise.all([hashValue(canonical(descriptor)), hashValue(canonical(descriptor.authority))]);
  if (link.operation_id === descriptor.operation_id || link.target_write_id !== descriptor.write_id || link.target_descriptor_hash !== descriptorHash || link.authority_episode_hash !== authorityHash ||
      link.writer_generation_id !== descriptor.writer_generation_id || link.owner_id !== descriptor.owner_id || link.asset_id !== descriptor.asset_id ||
      link.asset_version !== descriptor.asset_version || link.verification.object_key !== descriptor.object_key || link.verification.bucket !== descriptor.bucket ||
      link.verification.byte_size !== descriptor.payload.byte_size || link.verification.sha256 !== descriptor.payload.sha256 ||
      link.verification.content_type !== descriptor.payload.content_type) conflict();
  return frozenCopy(link);
}
export const validateLinkV2AgainstDescriptor = validateD2LinkTarget;

/** Pure expected/current snapshot comparison. Fresh source selection and status/
 * disabled/deletion/granted/active predicates remain the application's duty. */
export function assertUploadAuthorityCurrent(expectedRaw, currentRaw, state) {
  const expected = validateUploadAuthorityV2(expectedRaw), current = validateUploadAuthorityV2(currentRaw);
  valid(exact(state, ['stored_roles_json', 'credential_roles', 'now', 'policies']) && time(state.now) &&
    exact(state.policies, ['audience', 'authentication', 'processing']) && Object.values(state.policies).every(policy));
  const currentRoles = canonicalOwnerActiveRoles(state.stored_roles_json, state.credential_roles);
  if (!equal(currentRoles, current.account.active_roles) || !equal(expected, current)) conflict();
  const fresh = audience => audience.policy_version === state.policies.audience && (audience.next_review_at === null || audience.next_review_at > state.now);
  const consentFresh = (c, required) => c.policy_version === required && (c.expires_at === null || c.expires_at > state.now);
  if (current.session.expires_at <= state.now || current.session.refresh_expires_at <= state.now || !fresh(current.audience) ||
      !consentFresh(current.authentication_consent, state.policies.authentication) || !consentFresh(current.processing_consent, state.policies.processing)) conflict();
  for (const purpose of ['face_authentication', 'photo_processing']) {
    const g = current.purpose_basis[purpose].guardian;
    if (g && (!fresh(g.audience) || !consentFresh(g.authentication_consent, state.policies.authentication) ||
        g.request.expires_at <= state.now || g.approval.expires_at <= state.now)) conflict();
  }
  return true;
}
function parseCanonical(value, maximum) {
  let text; try {
    valid(typeof value === 'string' || value instanceof Uint8Array);
    text = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    if (encoder.encode(text).byteLength > maximum) fail(413, 'inventory_descriptor_v2_too_large');
    const parsed = JSON.parse(text); if (canonical(parsed) !== text) invalid(); return parsed;
  } catch (error) { if (error?.status) throw error; invalid(); }
}
export const parseDescriptorV2 = (value, input) => validateDescriptorV2(parseCanonical(value, DESCRIPTOR_V2_LIMITS.descriptor), input);
export const parseLinkV2 = (value, input) => validateLinkV2(parseCanonical(value, DESCRIPTOR_V2_LIMITS.link), input);
