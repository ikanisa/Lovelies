import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGateway } from './gateway.mjs';
import { RemoteDispatchLedger } from './remote-ledger.mjs';
import { ApnsAuthorization, ApnsProvider, FcmAuthorization, FcmProvider } from './providers.mjs';
import { privateProviderFile } from './private-files.mjs';
export async function configuredProviders(env = process.env) {
  // Default process startup cannot send provider work. Enable only with the
  // separately authorized provider deployment/test configuration.
  if (env.PUSH_PROVIDER_SEND_ENABLED !== 'true') return {};
  const providers = {};
  if (env.APNS_PRIVATE_KEY_FILE) providers.ios = new ApnsProvider({ authorization: new ApnsAuthorization({ teamID: env.APNS_TEAM_ID, keyID: env.APNS_KEY_ID, privateKey: await privateProviderFile(env.APNS_PRIVATE_KEY_FILE) }), topic: env.APNS_TOPIC, environment: env.APNS_ENVIRONMENT });
  if (env.FCM_SERVICE_ACCOUNT_FILE) providers.android = new FcmProvider({ authorization: new FcmAuthorization({ serviceAccount: JSON.parse(await privateProviderFile(env.FCM_SERVICE_ACCOUNT_FILE)), projectID: env.FCM_PROJECT_ID }), projectID: env.FCM_PROJECT_ID, packageName: env.ANDROID_PACKAGE_NAME });
  if (!Object.keys(providers).length) throw new Error('provider_send_enabled_without_configuration');
  return providers;
}
export async function configuredLedger(env = process.env, { fetcher = fetch } = {}) {
  // Never fall back to a receipt table inside the application restore boundary.
  // Read the independently persisted binding before loading any provider key.
  const ledger = new RemoteDispatchLedger(env.PUSH_LEDGER_URL, env.PUSH_LEDGER_TOKEN,
    { ledgerID: env.PUSH_LEDGER_ID, fetcher });
  if ((await ledger.control()).state !== 'serving') throw new Error('provider_ledger_unavailable');
  return ledger;
}
export function createNodeServer(handle) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? 'GET';
      const request = new Request('http://push.internal' + incoming.url, { method, headers: incoming.headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const result = await handle(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end('{"error":"gateway_request_unavailable"}'); }
  });
  server.requestTimeout = 45_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return server;
}
export async function start(env = process.env) {
  const port = Number(env.PORT ?? 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_gateway_port');
  const ledger = await configuredLedger(env), providers = await configuredProviders(env);
  const handle = createGateway({ ledger, providers, secret: env.PUSH_SERVICE_SECRET });
  const server = createNodeServer(handle);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, env.HOST ?? '127.0.0.1', resolve); }); }
  catch (error) { await Promise.allSettled(Object.values(providers).map(provider => provider.close())); throw error; }
  const close = async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await Promise.allSettled(Object.values(providers).map(provider => provider.close()));
  };
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(({ close }) => { process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close()); }).catch(() => { console.error('Push gateway startup failed; verify private configuration and independent ledger access.'); process.exitCode = 1; });
}
