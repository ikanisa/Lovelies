# Lovelies link association Worker candidate

This isolated candidate can serve the two reviewed public association documents
without replacing the shared `lovelies-web` Pages deployment. It serves only GET
and HEAD for the two exact paths on `https://lovelies.ikanisa.com`; every other
request is handed to `fetch` as the original Request. Whether Cloudflare sends
that request to the existing Pages origin is not yet qualified. The tests compare
the JSON with `docs/release/website-associations/` and exercise that local boundary.

The configuration has no routes or public Worker URL. It has not been deployed.
Before any deployment, verify the selected account, incremental cost and that
the configured Worker name does not already belong to an existing service.
The candidate serves complete fixed documents; it does not merge other apps'
statements. Before adding any route, refresh the existing zone routing and live
association responses, preserve and merge any existing statements, verify
same-zone Pages passthrough and Cloudflare security behavior, and test actual
Apple and Google association retrieval. A 27 October 2026 local readback using
Python's default user agent received Cloudflare error 1010 on the Pages domain;
the local test does not predict platform fetchers or justify weakening security.
Confirm the final app-signing certificate, Apple team/bundle, and native path and
entitlement configuration again before publication. Keep the existing site,
admin/photo domains, and any independently existing association statements.

Run the local tests from the repository root with:

```
node --test services/link-association-worker/test/worker.test.mjs
```

No route, deployment, provider result, device tap or store acceptance follows
from these tests. Release and rollback still need hosted readback and monitoring.
