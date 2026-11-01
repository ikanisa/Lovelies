// Public configuration only. The deployment may supply an explicit public API
// URL before this module loads; no service key belongs in the browser bundle.
const API_PATH = '/functions/v1/lovelies-api';
export function resolveRuntimeConfig(input = {}, location = globalThis.location) {
  const fallback = location?.protocol === 'https:'
    ? location.origin + API_PATH
    : 'http://127.0.0.1:55101' + API_PATH;
  const raw = input.apiBaseUrl ?? fallback;
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid_public_api_configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (typeof raw !== 'string' || raw !== raw.trim() || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, '') !== API_PATH ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback) ||
      location?.protocol === 'https:' && url.protocol !== 'https:') {
    throw new Error('invalid_public_api_configuration');
  }
  return Object.freeze({apiBaseUrl: url.origin + API_PATH, facePolicyVersion: 'registered-face-opencv-v1'});
}
export const runtimeConfig = resolveRuntimeConfig({apiBaseUrl: globalThis.LOVELIES_PUBLIC_API_URL});
