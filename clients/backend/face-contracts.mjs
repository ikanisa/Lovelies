import { fail, object, text, uuid, integer, expiry, freeze, copy } from './contracts.mjs';

export const FACE_PROTOCOL = 'lovelies-face-auth-v1';
export const MAX_FACE_CAPTURE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) fail('face_proof_invalid'); return encoded;
};
export const faceSigningBytes = (payload) => encoder.encode(canonical(payload));
export function toBase64url(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deviceSignature(value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value)) {
    try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); }
    catch { fail('device_signature_invalid'); }
  } else fail('device_signature_invalid');
  if (bytes.length !== 64) fail('device_signature_invalid');
  const encoded = toBase64url(bytes);
  if (typeof value === 'string' && encoded !== value) fail('device_signature_invalid');
  return encoded;
}
export function publicDeviceKey(value) {
  object(value);
  if (value.kty !== 'EC' || value.crv !== 'P-256' || 'd' in value ||
      Object.keys(value).some(key => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(key)) ||
      (value.ext != null && value.ext !== true) ||
      (value.key_ops != null && (JSON.stringify(value.key_ops) !== '["verify"]'))) fail('device_key_invalid');
  for (const coordinate of [value.x, value.y]) if (typeof coordinate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(coordinate)) fail('device_key_invalid');
  return copy(value);
}
export function faceChallenge(value, { purpose, accountId, deviceId }, now) {
  object(value);
  if (value.protocol !== FACE_PROTOCOL || value.purpose !== purpose) fail('face_challenge_invalid');
  uuid(value.challenge_id); uuid(value.account_id); uuid(value.device_id);
  text(value.device_revision, 128); text(value.policy_version, 128);
  if (typeof value.nonce !== 'string' || !/^lfn_[A-Za-z0-9_-]{43}$/.test(value.nonce)) fail('face_challenge_invalid');
  if ((accountId != null && value.account_id !== accountId) || (deviceId != null && value.device_id !== deviceId)) fail('account_scope_invalid');
  expiry(value.expires_at, now);
  if (Date.parse(value.expires_at) > now + 125000 || value.maximum_capture_bytes !== MAX_FACE_CAPTURE_BYTES) fail('face_challenge_invalid');
  const first = value.profile_id === null;
  if (first) {
    if (purpose !== 'registration' || value.profile_revision !== null || value.model_id !== null || value.required_captures !== 3 || JSON.stringify(value.poses) !== '["front","left","right"]') fail('face_challenge_invalid');
  } else {
    uuid(value.profile_id); text(value.profile_revision, 128); text(value.model_id, 128);
    if (value.required_captures !== 1 || JSON.stringify(value.poses) !== '["front"]') fail('face_challenge_invalid');
  }
  if (purpose === 'registration' && (typeof value.face_handle !== 'string' || !/^lfh_[A-Za-z0-9_-]{43}$/.test(value.face_handle))) fail('face_challenge_invalid');
  return freeze(copy(value));
}
function envelope(challenge) {
  return { protocol: 'lovelies-face-device-v1', challenge_id: challenge.challenge_id, nonce: challenge.nonce,
    purpose: challenge.purpose, account_id: challenge.account_id, device_id: challenge.device_id,
    device_revision: challenge.device_revision, profile_id: challenge.profile_id,
    profile_revision: challenge.profile_revision, policy_version: challenge.policy_version };
}
export function faceCapturePayload(challenge, { index, sha256, mime, byteSize }) {
  integer(index, 0, challenge.required_captures - 1); integer(byteSize, 1, MAX_FACE_CAPTURE_BYTES);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !/^[0-9a-f]{64}$/.test(sha256)) fail('face_capture_invalid');
  return freeze({ ...envelope(challenge), step: 'capture', capture_index: index, capture_sha256: sha256, mime, byte_size: byteSize });
}
export function faceCompletionPayload(challenge, captures) {
  if (captures.length !== challenge.required_captures || captures.some((item, index) => item.index !== index)) fail('face_captures_incomplete');
  return freeze({ ...envelope(challenge), step: 'complete', capture_manifest: copy(captures) });
}
export async function faceCaptureDigest(bytes) {
  if (!globalThis.crypto?.subtle) fail('device_crypto_unavailable');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
}
