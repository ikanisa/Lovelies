import { PROJECT_ID, sha256, canonical } from '../src/journal.mjs';

let sequence = 0;
export const id = () => `00000000-0000-8000-8000-${String(++sequence).padStart(12, '0')}`;
export const clone = value => JSON.parse(JSON.stringify(value));
export const policies = Object.freeze({ audience: 'audience-v1', authentication: 'auth-v1', processing: 'photo-v1' });
export const NOW = 1000;
const account = owner => ({ account_id: owner, auth_epoch: 1, identity_state: 'registered_face' });
const consent = (owner, purpose) => ({ id: id(), account_id: owner, purpose, policy_version: purpose === 'face_authentication' ? policies.authentication : policies.processing,
  created_at: 10, expires_at: 10000, profile_revision: null });
const audience = (owner, age_band = '18_plus') => ({ account_id: owner, age_band, status: 'eligible', version: 1,
  policy_version: policies.audience, declared_at: 10, next_review_at: 10000 });
const profile = (owner, c) => ({ id: id(), account_id: owner, revision: 'profile-v1', auth_epoch: 1, auth_consent_id: c.id });
export function authority({ minor = false, differentGuardians = false, roles = ['user'] } = {}) {
  const owner = id(), auth = consent(owner, 'face_authentication'), processing = consent(owner, 'photo_processing'), p = profile(owner, auth), d = { id: id(), account_id: owner, revision: 'device-v1', created_at: 10 };
  const value = { protocol: 'lovelies-upload-authority-v2', account: { ...account(owner), active_roles: [...roles] },
    session: { id: id(), account_id: owner, auth_method: 'registered_face', auth_epoch: 1, created_at: 20, expires_at: 5000,
      refresh_expires_at: 10000, face_profile_revision: p.revision, face_profile_epoch: p.auth_epoch, face_consent_id: auth.id, device_id: d.id, device_revision: d.revision },
    device: d, profile: p, authentication_consent: auth, processing_consent: processing, audience: audience(owner, minor ? '13_17' : '18_plus'),
    purpose_basis: { face_authentication: { purpose: 'face_authentication', policy_version: policies.authentication, guardian: null },
      photo_processing: { purpose: 'photo_processing', policy_version: policies.processing, guardian: null } } };
  if (minor) {
    let shared;
    for (const purpose of ['face_authentication', 'photo_processing']) {
      let basis;
      if (shared && !differentGuardians) basis = clone(shared);
      else {
        const guardian = id(), c = consent(guardian, 'face_authentication');
        basis = { account: account(guardian), audience: audience(guardian), profile: profile(guardian, c), authentication_consent: c,
          request: { id: id(), child_account_id: owner, guardian_account_id: guardian, child_audience_version: value.audience.version,
            policy_version: policies.audience, revision: 2, created_at: 30, expires_at: 10000, reviewed_by: id(), reviewed_at: 40 } };
      }
      basis.approval = { id: id(), request_id: basis.request.id, child_account_id: owner, guardian_account_id: basis.account.account_id,
        purpose, policy_version: value.purpose_basis[purpose].policy_version, version: 1, created_at: 30, expires_at: 10000,
        guardian_audience_version: basis.audience.version };
      if (!shared) shared = clone(basis);
      value.purpose_basis[purpose].guardian = basis;
    }
  }
  return value;
}
export function descriptor(options) {
  const a = authority(options), operation = id(), write = id(), asset = id(), version = 'Version_1';
  const value = { version: 2, project_id: PROJECT_ID, operation_id: operation, write_id: write, database_id: id(), incarnation_id: id(), writer_generation_id: id(),
    action: 'put', kind: 'direct-source', owner_id: a.account.account_id, asset_id: asset, asset_version: version, bucket: 'QUARANTINE',
    object_key: `source/${a.account.account_id}/${asset}/${version}/${write}`, authority: a,
    payload: { byte_size: 3, sha256: 'a'.repeat(64), content_type: 'image/jpeg', source_byte_size: 3, offset_bytes: null, transfer_sha256: null } };
  const input = { version: 2, project_id: PROJECT_ID, operation_id: operation, input_hash: 'b'.repeat(64), allocations: { id_0: write }, events: [], resources: [value], links: [],
    expected: { database_id: value.database_id, incarnation_id: value.incarnation_id, checkpoint: { revision: 1, hash: 'c'.repeat(64) }, cursor: { sequence: 0, hash: '0'.repeat(64) } },
    writer_generation_id: value.writer_generation_id };
  return { value, input };
}
export async function link(d) {
  return { version: 2, project_id: PROJECT_ID, operation_id: id(), writer_generation_id: d.writer_generation_id, owner_id: d.owner_id, asset_id: d.asset_id,
    asset_version: d.asset_version, target_write_id: d.write_id, target_descriptor_hash: await sha256(canonical(d)), relation: 'asset-source', offset_bytes: null,
    authority_episode_hash: await sha256(canonical(d.authority)), verification: { protocol: 'lovelies-object-verification-v1', verification_id: id(), bucket: 'QUARANTINE',
      object_key: d.object_key, storage_version: 'provider-version-1', strong_etag: '"actual-strong-etag"', byte_size: d.payload.byte_size, sha256: d.payload.sha256,
      content_type: d.payload.content_type, custom_metadata: { asset_id: d.asset_id, source_version: d.asset_version, source_checksum_sha256: d.payload.sha256 },
      actual_put_status: 201, actual_put_etag: '"actual-strong-etag"', actual_put_version: 'provider-version-1', read_completed_at: NOW } };
}
export const current = a => ({ stored_roles_json: JSON.stringify(a.account.active_roles), credential_roles: [...a.account.active_roles], now: NOW, policies: { ...policies } });
