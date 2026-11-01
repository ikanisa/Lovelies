/** Shared, fail-closed deployment gate. It contains no credential material. */
export const LIFECYCLE_PROTOCOL = 'lovelies-managed-auth-lifecycle-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateLifecycleGate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'key_sha256,protocol,rotation_id,state' ||
      value.protocol !== LIFECYCLE_PROTOCOL || !['open', 'blocked', 'verification_only'].includes(value.state) ||
      !/^[0-9a-f]{64}$/.test(value.key_sha256 ?? '') ||
      !(uuid.test(value.rotation_id ?? '') || value.state === 'open' && value.rotation_id === null)) {
    throw Error('deployment_lifecycle_unavailable');
  }
  return value;
}
export async function configuredKeyFingerprint(value) {
  let bytes;
  try {
    if (typeof value !== 'string' || value.length > 48 || !/^[A-Za-z0-9_+/=-]+$/.test(value)) throw Error();
    bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    if (bytes.length !== 32) throw Error();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  } catch { throw Error('deployment_lifecycle_unavailable'); }
  finally { bytes?.fill(0); }
}
export function lifecycleRequestAllowed(value, method, pathname, keyFingerprint) {
  const gate = validateLifecycleGate(value);
  if (gate.key_sha256 !== keyFingerprint || gate.state === 'blocked') return false;
  if (gate.state === 'open') return true;
  return method === 'GET' && ['/lovelies-api/health', '/lovelies-api/ready'].includes(pathname);
}
