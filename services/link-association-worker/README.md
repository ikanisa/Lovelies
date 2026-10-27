# Lovelies link association Worker candidate

This isolated candidate can serve the two reviewed public association documents
without replacing the shared `lovelies-web` Pages deployment. It serves GET
and HEAD for the two exact paths on `https://lovelies.ikanisa.com` and returns
405 for other methods on those paths. Requests to other paths or hosts are handed
to `fetch` as the original Request. Whether Cloudflare sends those requests to
the existing Pages origin is not yet qualified. The tests compare the JSON with
`docs/release/website-associations/` and exercise that local boundary.

The configuration has no routes or public Worker URL. An earlier copy was uploaded to
the existing Cloudflare account as version
`f1249cc7-ce52-4e55-8e8e-8bff803a0eb0`; the dashboard showed it ready with no
enabled URL, routes, domains or bindings. The existing site's three checked
roots and the two unpublished association paths matched their earlier responses.
That hosted version predates the local 405 handling and still forwards unsupported
methods; it is not the current source.
This does not qualify a hosted Worker request or site-wide preservation.
Evidence: `/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-hosted-20261027/attempt-01/hosted-readback.json`.
The dashboard's HTTP preview returned a configuration error because the service
has neither a workers.dev URL nor a route. No Worker response was observed.
Evidence: `/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-hosted-20261027/attempt-01/preview-attempt-01.json`.

Before updating the Worker, verify the selected account, incremental cost and
the identity and current version of the existing candidate service.
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

No public route, platform retrieval, device tap or store acceptance follows from
the local tests or route-free upload. Release and rollback still need hosted
readback and monitoring.
