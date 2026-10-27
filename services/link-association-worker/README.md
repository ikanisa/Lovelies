# Lovelies link association Worker candidate

This isolated candidate can serve the two reviewed public association documents
without replacing the shared `lovelies-web` Pages deployment. It serves GET
and HEAD for the two exact paths on `https://lovelies.ikanisa.com` and returns
405 for other methods on those paths. Requests to other paths or hosts are handed
to `fetch` as the original Request. Whether Cloudflare sends those requests to
the existing Pages origin is not yet qualified. The tests compare the JSON with
`docs/release/website-associations/` and exercise that local boundary.

The checked-in configuration has no routes or public Worker URL. An earlier copy was uploaded to
the existing Cloudflare account as version
`f1249cc7-ce52-4e55-8e8e-8bff803a0eb0`; the dashboard showed it ready with no
enabled URL, routes, domains or bindings. The existing site's three checked
roots and the two unpublished association paths matched their earlier responses.
That then-active hosted version predates the local 405 handling and forwards
unsupported methods. The revised source was uploaded separately as version
`11a0d465-98cb-4eb2-b170-9cd41de67055`; at that checkpoint it was not deployed
or routed. The earlier version remained active and both public paths returned
404. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-methods-20261028/attempt-01/staged-version/postflight.json`.
That checkpoint did not qualify a hosted Worker request or site-wide preservation.
Evidence: `/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-hosted-20261027/attempt-01/hosted-readback.json`.
The earlier dashboard HTTP preview returned a configuration error because the service
then had neither a workers.dev URL nor a route. That preview showed no Worker response.
Evidence: `/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-hosted-20261027/attempt-01/preview-attempt-01.json`.

On 28 October 2026 the revised version was deployed and two exact queryless
routes were added to it in the existing zone. Public GET and HEAD checks passed,
Google Digital Asset Links returned the expected package/fingerprint, and the
Apple CDN returned the expected AASA. The sampled site, admin and photo root
responses matched the preflight. Query-string variants remain on the prior
origin route. Device behavior and signed artifacts remain unverified. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/link-association-publish-20261028/attempt-01/`.

Before further updating the Worker, verify the selected account, incremental cost and
the identity and current version of the existing service. The two routes are
dashboard-managed; keep `route` and `routes` absent from the Wrangler
configuration unless deliberately changing that ownership. The Worker serves
complete fixed documents; it does not merge other apps' statements. Before
changing routes or statements, refresh the zone routing and live responses,
preserve any other apps' statements, and verify relevant Pages and security
behavior. A 27 October 2026 local readback using
Python's default user agent received Cloudflare error 1010 on the Pages domain;
the local test does not predict platform fetchers or justify weakening security.
Confirm the final app-signing certificate, Apple team/bundle, and native path and
entitlement configuration again before publication. Keep the existing site,
admin/photo domains, and any independently existing association statements.

Run the local tests from the repository root with:

```
node --test services/link-association-worker/test/worker.test.mjs
```

No device tap or store acceptance follows from the local or hosted readbacks.
Release and rollback still require signed-device qualification and monitoring.
