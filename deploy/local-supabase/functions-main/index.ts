/** Single application router for the pinned self-hosted Edge Runtime.
 * User capability and maintenance authentication live in lovelies-api.
 * This profile exposes no generic function loader or sample functions.
 */
import { configuredKeyFingerprint, lifecycleRequestAllowed } from './lifecycle-gate.mjs';

async function lifecycleAdmission(request: Request, pathname: string): Promise<boolean> {
  // Mount the directory, not this file: each read must see an atomic host rename.
  const filename = '/run/lovelies/lifecycle/gate.json';
  const directory = await Deno.lstat('/run/lovelies/lifecycle');
  const before = await Deno.lstat(filename);
  if (!directory.isDirectory || directory.isSymlink || directory.mode === null || (directory.mode & 0o022) !== 0 ||
      !before.isFile || before.isSymlink || before.mode === null || (before.mode & 0o022) !== 0 || before.size > 2048) return false;
  const text = await Deno.readTextFile(filename);
  const after = await Deno.lstat(filename);
  if (!after.isFile || after.isSymlink || before.ino !== after.ino || before.mtime?.getTime() !== after.mtime?.getTime() || before.size !== after.size) return false;
  return lifecycleRequestAllowed(JSON.parse(text), request.method, pathname,
    await configuredKeyFingerprint(Deno.env.get('MANAGED_AUTH_ENCRYPTION_KEY')));
}
Deno.serve(async (request: Request) => {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/lovelies-api' && !pathname.startsWith('/lovelies-api/')) {
    return Response.json({ error: 'route_unavailable' }, { status: 404 });
  }
  try {
    if (!await lifecycleAdmission(request, pathname)) {
      return Response.json({ error: 'deployment_lifecycle_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const environment = { ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: 'lovelies-api' };
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: '/home/deno/functions/lovelies-api',
      memoryLimitMb: 150,
      workerTimeoutMs: 400_000,
      context: { importMapPath: '/home/deno/functions/deno.jsonc', supervisor: { requestAbsentTimeoutMs: 60_000 } },
      noModuleCache: false,
      envVars: Object.entries(environment),
    });
    const forwarded = new Request(request);
    forwarded.headers.delete('sb-api-key');
    EdgeRuntime.applySupabaseTag(request, forwarded);
    // A failed dispatch is not replayed here. The application/native idempotency
    // contract decides whether a later caller retry is safe, without cloning
    // and buffering a photo body in the main worker.
    return await worker.fetch(forwarded);
  } catch {
    return Response.json({ error: 'application_runtime_unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
});
