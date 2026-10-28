# Lovelies Supabase backend

Owner direction, 23 October 2026: Lovelies replaces the existing Memories store
listings using Supabase project `ltqfplqevxztlswlzexn`. The owner confirms there are
no real Memories users, photos or subscriptions to migrate. Preserve the existing
store identities and signing; do not import donor tables, users or content.

## Implementation

`services/supabase-api` is a complete asynchronous port of the active Lovelies
protocol engine. Existing Cloudflare source is preserved as provenance; it is not
a dependency of the Supabase runtime. PostgreSQL owns accounts, custom sessions,
consents, capture/device/recovery/profile state, processing origins, immutable
review snapshots, exact approval subsets, grants, entitlements, privacy, support,
safety, operator audit, retention and durable job leases.

The API uses the app's existing anonymous-first authentication. Exactly three
individually signed enrollment captures are verified by the backend before that
same account receives a registered-face session. Later sign-in and recovery use
the registered reference, single-use challenges, device signatures, current
auth epochs and separate purpose consent. JWT issuer is `lovelies-supabase`;
audience remains `lovelies-clients`. These are custom application credentials,
not Supabase managed Auth users. No OTP, liveness or camera attestation is added.

All database calls are awaited. A PostgreSQL connection is reserved for each real
transaction; `AsyncLocalStorage` prevents concurrent requests from joining one
another's transaction. A transaction advisory lock preserves the prior engine's
single-authority serialization. Authorization is rechecked inside the same
transaction as each protected publication, approval and grant. Network providers
and Storage writes retain their durable intents and post-await guards. No series
of independent PostgREST read/write requests substitutes for a transaction.
The advisory lock is deliberately conservative; measure actual load before
changing its scope.

The core v7 migration creates **62 private tables, 27 indexes and four immutable-update
triggers**, plus bounded JSON compatibility helpers. It uses `BIGINT` for epoch
milliseconds and byte counters. Tables remain in the non-exposed
`lovelies_private` schema. `anon`, `authenticated` and `PUBLIC` receive no schema,
table or function access. RLS is enabled and forced on every application table;
only the non-bypass `lovelies_api` backend role has policies. The runtime switches
to that role within each transaction. The backend still enforces account/session,
consent, ownership, exact-recipient and operator guards; the role is never a
client credential. No arbitrary SQL RPC or new public security-definer function
is exposed.
An existing backend role with login, inheritance, bypass/admin privileges, or
membership granted to `anon`/`authenticated` causes migration to fail for review;
its name alone does not establish the intended private boundary.

Private Supabase Storage buckets are `lovelies-photos`, `lovelies-quarantine`
and `lovelies-privacy-exports`. Originals, signed captures, derived references,
previews and exports are accessed only through the guarded API. The server-only
Storage key never enters a native bundle. Do not add client Storage policies or
public buckets. The adapter checks actual object metadata, digest/version
bindings and durable DELETE followed by absent-object confirmation. No public
Storage URL or long-lived Storage capability is returned to users.

A PostgreSQL job queue replaces Cloudflare Queues. Stable message identities,
leases, bounded retries and domain-level durable idempotency survive ambiguous
responses and isolate loss. Invoke the protected `POST /_internal/maintenance`
endpoint regularly from an authenticated scheduler to drain jobs and run cleanup,
retention and outbox recovery. A missing scheduler is a deployment blocker.
Job failure is reported without logging SQL, captures, tokens or provider bodies.

The private ML boundary reads source/reference bytes from Supabase and calls
`/internal/face` and `/internal/photo` through pinned authenticated HTTPS.
The [OpenFace integration](openface-integration.md) adds an account-free still
worker and explicit v2 references. Readiness queries the loaded worker; requests
and results bind package/model/processing identities and exact request hashes.
Unknown legacy reference spaces fail closed, with existing data preserved.
Real recognition evaluation and the exact target image qualification remain
necessary. Supabase Edge does not run the heavy face model itself. No Cloudflare
runtime binding is needed by this API.

## Native API

Base: `https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api`.
The Edge adapter accepts the gateway/function prefix; generated preview and
original-download URLs preserve it. Relative upload/export paths retain their
existing native contract.

| Journey | Existing route/contract |
|---|---|
| Session | `POST /auth/anonymous` with `{}`; `/auth/session/refresh`, `/auth/logout`, `GET /me` |
| Enrollment/sign-in/recovery | Existing `/auth/face/*` challenges, proofs, completions, signed recovery and profile-control protocols retained |
| Library | `POST /community/action`, action `photos`, payload `source` (`received`, `contributions`, `all`), `query` (up to 500 characters), `limit` (1–100), `before_at` ISO and `before_id` UUID; response `items`, `next_cursor` |
| Category | Optional `category`: `all`, `portraits`, `landscapes`; portrait/landscape use verified rendition dimensions, not a guessed face classification |
| Review | Actions `sharing.snapshot`, `sharing.preview`, `sharing.commit`, `operation` with the existing version/operation-key contract |
| Requests/history | Actions `requests` or `inbox` are recipient-only; `history` is sender-only. All return `{items:[receipt...]}`; `request.decide` retains recipient acceptance before access |
| People/viewer | Existing `people`, `person`, `person.photos`, `photo.people`, `/community/media/:id/preview`, `/previews/sign` |
| Upload | Existing `/uploads/session`, raw/chunk upload, complete/status/cancel contracts preserved |
| Support | `GET /support/requests` returns `support_requests`; `POST` with `subject` (3–160), `details` (5–4000), `operation_key` returns `{id,status,revision}`; `GET /support/requests/:id` is owner-only |
| Store purchases | `POST /subscriptions/apple/transactions`: `product_id`, `signed_transaction`, `operation_key`; Google equivalent `/subscriptions/google/transactions`: `product_id`, `purchase_token`, `operation_key` |
| Store operation recovery | `POST /me/store-operations` with only `operation_key`; authenticated read-only historical receipt or `unknown` |
| Entitlement/download | `GET /me/entitlements`; `POST /downloads/sign` with the existing asset/operation-key contract, then guarded returned `download_url` |
| Push | `GET/POST /me/push-devices`; registration `platform`, `push_token`, `operation_key`; `DELETE /me/push-devices/:id` with `operation_key` |
| Privacy | Existing `/privacy-requests`, `/privacy/account-deletion`, `/privacy-exports/:request_id/grant` and export retrieval contracts retained |
| Administration | Existing `/admin/users`, `/admin/users/:id`, user sessions/revocation, support review, safety reports, matches, privacy reviews and retention/metrics routes retained; require current registered-face admin authority |

The locally implemented store-operation receipt is historical, not an entitlement
or proof that StoreKit/Play completed a transaction. A client must bind a
committed receipt to its own current account, key, action, source, original
credential digest and canonical input hash before using the result for recovery;
`unknown` is nonterminal. New operations persist a versioned SHA-256 credential
digest instead of the Apple JWS or Play token in the operation input. Exact
legacy raw-input rows remain replayable and are reported as `legacy-raw-v0`;
they have not been erased or migrated by this change. `digest-v1` hashes the
versioned redacted input. A retired receipt is unavailable; malformed receipts
fail closed. Current access continues to require `/me/entitlements` and its
current provider-backed state. This handler has only local synthetic tests; it
has not been deployed or qualified with an actual store transaction.

An inactive push token can move to a verified next account on the same phone:
its former row receives a retired hash and keeps the old account's delivery
history. Active tokens cannot be taken over. Logout/deactivation cancels pending
sends; same-device platform rotation disables the previous token. Provider
acceptance still needs a real APNs/FCM receipt and ambiguous-send reconciliation.
The private gateway's definitive `rejected` receipt is terminal for that
operation, including diagnostic `retryable=true`; invalid-token retirement
requires its explicit `token_invalid` flag. Rejected destinations retain the
inbox notification and do not acquire an accepted provider receipt. Only an
operation-bound `not_dispatched` result permits the identical send to retry,
after current account, epoch, device, token and preference checks. Such retries
are bounded. `preparing`, `dispatching`, `ambiguous` and `unknown` stay on hold;
their status lookup is gateway-ledger reconciliation, not a provider delivery
lookup. Logout cannot be overwritten by a late ambiguous result.

## Durable refresh delivery — schema 8

The existing `POST /auth/session/refresh` request containing only
`refresh_token` is unchanged: the token is consumed once and a duplicate fails.
Clients which durably journal a refresh before dispatch may opt into this exact
body on the same endpoint:

```json
{
  "protocol": "lovelies-refresh-delivery-v1",
  "refresh_token": "<original refresh token>",
  "rotation_key": "<fresh UUID>",
  "delivery_secret": "<32 independent random bytes as 43-character unpadded base64url>"
}
```

The first authorized exchange atomically consumes the original token once,
creates one successor and stores an encrypted exact credential-result receipt.
The response has the normal credential fields plus `protocol`, `rotation_key`,
`access_expires_at`, `refresh_expires_at` and `delivery_expires_at`; all three dates
are absolute ISO 8601 timestamps. It echoes `account_id` through the normal
credential contract, never the delivery secret or its hash. Matching delivery
retries return the same result and do not rotate again. `expires_in: 900` is the
original access lifetime; **use `access_expires_at`, never retry-time plus 900**.
If recovered access has expired, first persist that successor, then rotate its
still-valid refresh token using a new durably journaled operation.

Persist original account/credentials, rotation key and delivery secret before
the first request. Reuse that exact request after response loss or reload. Save
the validated successor into its authoritative enrollment/recovery/profile/login
journal and generic credential slot before retiring the delivery record.
Account changes, logout and cancelled work must fence late adoption locally.

Only an exact original-session/account/key/secret binding can deliver a result.
Every replay checks the current unrotated successor, account epoch/status/roles
and, for a registered face, profile, authentication consent/policy and device.
Expired access is allowed for delivery alone; a revoked or rotated successor
cannot be delivered. This grants no authority from a face-device key. Wrong or
malformed binding, unknown original tokens, unrelated consumption, cancellation
or retired authority fails with HTTP 401 (`refresh_invalid` or the existing
authority error). A retained, matching expired receipt returns HTTP 410
`refresh_delivery_expired`. Missing/changed encryption material, corrupt
ciphertext/IV or altered authenticated metadata fails closed with HTTP 503
`refresh_delivery_unavailable`; no credential result or replacement session is
returned. Rotating `AUTH_SIGNING_SECRET` also invalidates delivery encryption:
plan session retirement/recovery rather than treating key rotation as a replay.

`POST /auth/session/refresh/cancel` accepts the identical four-field request.
Its acknowledgement is exactly `protocol`, `rotation_key`, `account_id`,
`status: "cancelled"`, without credentials. A matching active receipt revokes
its exact current successor with logout-equivalent cleanup and clears its
ciphertext/IV. An already retired successor cannot cancel newer session/device
work. If cancellation wins before the first refresh, it binds a tombstone and
consumes/revokes the original session, preventing a late legacy or v2 first
dispatch from creating a successor. Matching retained cancellation repeats are
idempotent; mismatch/unknown or unrelated consumed authority fails HTTP 401.
Clients must persist a retired marker before local sign-out and must never
adopt a late reply while cancellation is unresolved.

The additive migration is
`supabase/migrations/20261023210000_refresh_delivery.sql`, applied after the
unchanged `20261023162016_lovelies_private_core.sql`. It requires schema 7 and
the baseline's private non-bypass role/migration membership, adds one private
forced-RLS table and index, and records schema 8: **63 tables, 28 indexes, four
immutability triggers** in total. Runtime readiness now requires schema 8.
The core generator refuses rewriting the frozen v7 baseline; subsequent schema
changes require additive migrations. This document is not evidence of hosted
migration application.

Receipts use AES-256-GCM with a random 96-bit IV, a domain-separated HKDF key
derived from `AUTH_SIGNING_SECRET`, and authenticated account/session/key/hash/
successor/time metadata. Only a SHA-256 delivery-secret hash and encrypted
credential result persist. Receipt delivery expires after 24 hours, capped by
the original refresh deadline. Maintenance removes at most 100 expired receipts
per invocation; a pruned receipt fails HTTP 401 and never permits a new rotation.
Pre-dispatch cancellation still blocks rotation after pruning because its
original session remains revoked/consumed. Privacy exports exclude all delivery
material; erasure immediately retires its ciphertext, and session/account foreign
keys cascade receipt deletion without blocking account cleanup.

## Local verification

`npm test` in `services/supabase-api` runs the preserved protocol regressions on
embedded PostgreSQL with synthetic face/store/push verdicts and in-memory private
Storage. Those tests exercise SQL, current authority, recovery, exact approvals,
entitlements, privacy and jobs. The fallback explicitly substitutes the advisory
lock because one embedded backend cannot establish distributed serialization.

With a server-only `TEST_DATABASE_URL` for an explicitly disposable local
PostgreSQL container, the same harness uses the real production driver and its
three-connection pools. Each harness creates and later drops only its own
randomly named `lovelies_test_*` database; existing databases are never reset.
The test path refuses remote hosts. Keep test credentials out of logs and source.
`test/postgres-concurrency.test.mjs` requires this mode and otherwise skips.

The real PostgreSQL concurrency cases verify a waiting database advisory lock
across independent API pools, at least three actual backend connections,
rollback isolation, the non-bypass backend role, twelve simultaneous refresh
requests with exactly one successful consumption, and concurrent review/recipient
approval with only the exact three approved grants. These passed locally on
PostgreSQL 17.6. In-memory Storage and synthetic providers remain fixtures even
in real PostgreSQL mode; this is not Supavisor, hosted Storage, device, model or
provider acceptance.
The actual Deno entrypoint also passed a loopback-only PostgreSQL smoke for
health, anonymous account/session creation, current `/me`, refresh consumption,
old-token denial and logout revocation. Its readiness remained unavailable
without configured model/Storage services, as required. A separate strict
non-superuser `CREATEROLE`/`NOBYPASSRLS` migration test passed; the initial schema
metadata is seeded before forced RLS begins. `LOVELIES_BIND_HOST` accepts only
an explicit loopback test override; hosted default listener behavior remains.

The earlier v7 real-PostgreSQL validation covered **182 distinct cases**:
173 unchanged cases reuse the complete run, and all nine cases in the affected
remaining-runtime file passed its final rerun. The first complete run recorded
181/182: its privacy fixture attempted a competing manual executor after the
operated queue had already claimed the approved work. Only that test changed to
reconcile the authoritative completion; no production source or schema changed.
The failed run is preserved. TypeScript passed. See the source-bound
[verification results](../verification/supabase-release-20261023/backend-final/backend-verification-results.json)
and [55-input source freeze](../verification/supabase-release-20261023/backend-final/backend-source-freeze.json).

The schema-8 refresh-delivery changes passed **49/49 affected cases** on actual
PostgreSQL 17.6 with no skips (about 46 seconds), plus 26 embedded cases with the
one real-concurrency case correctly skipped. This includes identical and
conflicting three-pool refresh races, cancellation before/after commit, current
authority and encryption tamper/secret-rotation denial, bounded pruning,
credential-free exports and writer-held account erasure. The strict non-superuser
test applies unchanged v7 then additive v8; actual Deno executes HKDF/AES replay
and cancellation as well as legacy one-use refresh/logout. TypeScript passed.
These affected results overlap the root209-distinct-case reconciliation:175 unchanged cases from the retained full attempt plus34/34 in the corrected affected account-recovery file. See `backend-integrated-reconciled-final.json`; this is not a single green209-case aggregate run.
Source hashes, commands and preserved raw logs are in
[refresh-delivery verification](../verification/supabase-release-20261023/backend-refresh-delivery/result.json).

## Deployment inputs and gates

See the server-only `.env.example` in the service folder. Configure project DB
credentials (Supavisor transaction pooler supported, prepared statements disabled),
Storage secret, fresh independent auth/media/maintenance secrets, current consent
versions, exact store identities/product IDs, private ML service and store/push
provider settings. Credentials must enter the deployment secret store, never Git,
chat, native source or submission screenshots. Validate the trusted proxy chain
for public auth rate limits; raw addresses are not retained.
Private inference/store/push calls pin HTTPS destinations (HTTP is allowed only
for explicit loopback tests), overwrite the service bearer credential, deny
redirects and preserve caller cancellation. One 55-second network deadline
covers response headers and body consumption.
Remote database connections verify TLS certificate and hostname. Set
`LOVELIES_DATABASE_CA` to the project's CA PEM if the chosen direct endpoint
requires it; certificate failures remain failures. The local disposable test
container is the only plaintext database path.

The owner-approved v7 plus additive v8 transaction was applied through the visible
Supabase SQL editor on 23 October2026. Hosted readback confirms schema 8,63 forced-RLS
tables,63 backend-only policies, zero accounts and no anon/authenticated schema
usage or backend-role membership. Three private buckets were created through the
Storage dashboard and read back: each 20971520 bytes, exact expected MIME sets and
zero client Storage policies. The existing public RLS event trigger's unnecessary
client EXECUTE grants were removed with a fingerprint-guarded transaction;
its definition and enabled trigger were preserved. Current receipts are under
`verification/supabase-release-20261023/`.

Manual editor execution does not automatically establish Supabase CLI migration
history. Before any future `db push`, restore authorized CLI/project access, inspect
remote migration history and use supported `migration repair` for the exact two
already-applied versions, then read back parity. Do not blindly rerun fresh-schema
DDL or hand-write Supabase's managed history. The application records versions7/8
in its own private schema. No application API or supporting service was deployed.

`services/supabase-api/scripts/provision-storage.mjs` defaults to read-only and can
reverify bucket configuration after a server-only credential is available.
`--apply` is an explicit provisioning operation; never modify Storage-managed
schema tables with SQL. The script refuses public or differently configured
existing buckets. Actual upload/read/delete/absence semantics still need hosted
API/provider qualification. Server-only configuration/secret inventory, trusted
proxy chain, backup/restore, scheduler, operators and private inference remain
release gates.

Supabase Edge config has `verify_jwt=false` because custom app credentials are
verified by the engine against current database authority. That does not make
protected routes anonymous: the app checks its own signature and every current
session binding. Health is public; internal maintenance requires its independent
secret. The service has no production fixture, raw SQL or queue-injection route.

Verify hosted `ready`, three-selfie enrollment, fresh-face login, all consent
changes, exact subset review/acceptance/revocation, interrupted uploads, purchases,
privacy deletion/exports, provider callbacks, admin authority and scheduler
recovery before switching the store build to it. Local proof is not hosted
acceptance, real model qualification, device testing or store approval.

Current Supabase references checked for this implementation:
[database access](https://supabase.com/docs/guides/api/securing-your-api),
[private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[Storage schema read-only boundary](https://supabase.com/docs/guides/storage/schema/design),
[product security](https://supabase.com/docs/guides/security/product-security),
and [changelog](https://supabase.com/changelog).
