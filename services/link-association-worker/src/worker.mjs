// Public website associations only. This candidate has no production routes.
// The tests bind these documents to the independently reviewed release inputs.
const ANDROID = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: 'com.lovelies.memories',
    sha256_cert_fingerprints: [
      '06:C0:F4:1F:B2:F6:5D:33:0F:70:15:44:D6:6E:30:69:87:4F:5C:58:A6:B7:DE:2C:2D:C7:0E:CD:BA:3F:37:A8',
    ],
  },
}];
const APPLE = {
  applinks: {
    details: [{
      appIDs: ['63STJ5N27W.com.lovelies.memories'],
      components: [
        { '/': '/support', exclude: true },
        { '/': '/support/', exclude: true },
        { '/': '/match/*' },
        { '/': '/support/*' },
        { '/': '/payment/*' },
      ],
    }],
  },
};
const DOCUMENTS = new Map([
  ['/.well-known/assetlinks.json', JSON.stringify(ANDROID)],
  ['/.well-known/apple-app-site-association', JSON.stringify(APPLE)],
]);

/** Only association documents are handled here; all other paths pass through. */
export async function handle(request, passthrough = fetch) {
  const url = new URL(request.url);
  const body = DOCUMENTS.get(url.pathname);
  if (url.origin !== 'https://lovelies.ikanisa.com' || !body) {
    return passthrough(request);
  }
  // The published documents only support reads. Forwarding another method to
  // this same host could re-enter the route instead of reaching Pages.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

export default { fetch: request => handle(request) };
