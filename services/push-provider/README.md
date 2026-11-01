# Private push provider

The active custody listener is `src/ledger-server.mjs`, backed by the separate
locally hosted Supabase PostgreSQL database and private TLS configuration in
`deploy/local-supabase/compose.custody.yml`. It shares only the transactional
adapter with the restore journal; each protocol has its own role and schema.
Application database rollback cannot overwrite these receipt/roster volumes.
The old Worker adapter is retained for compatibility tests, not deployment.
The active delivery listener is `src/server.mjs`; both APNs and FCM must be
configured and explicitly enabled before it reports delivery readiness.

The selected runtime uses complete immutable v2 notification plans, an independent
Supabase PostgreSQL custody ledger, exact request/token digests and a pinned provider
configuration generation. It supports lookup-only recovery after application
database rollback and permanently retires a subject before account erasure.

Read [ROSTER_CONTRACT.md](ROSTER_CONTRACT.md) for the active wire contract,
required deployment pins, empty-v1-only initialization, generation fencing,
deletion proof and remaining external qualification. The archived v1 contract is
in [RECEIPT_CONTRACT.md](RECEIPT_CONTRACT.md). Hosting and custody context are in
[docs/push-provider.md](../../docs/push-provider.md).

Use Node24 and the workspace lockfile. `npm test` runs local tests; `npm run check`
checks all service source syntax. `npm run generation` derives the fingerprint
from the actual intended protected provider files/configuration without sending
network requests. `npm start` verifies its configured independent bindings and
actual provider generation before opening the listener.

No ledger UUID, bootstrap UUID, generation, private endpoint or secret is
fabricated by the example configuration. Missing configuration is a deployment
blocker. Running the source or local test suite does not deploy a ledger/gateway,
send a real notification, or verify a signed mobile build.
