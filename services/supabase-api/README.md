# Lovelies local Supabase backend

This is the active backend for the owner's 1 November 2026 local Supabase direction. The deployment profile is `deploy/local-supabase`; the public mobile/admin API remains `/functions/v1/lovelies-api`. Historical cloud project identifiers in immutable journal/protocol namespaces are provenance identifiers, not network destinations. No code here selects the old hosted project as a deployment default.

## One coherent schema and protocol set

Apply `supabase/migrations/*.sql` in lexical order using the configured migration owner. The selected chain retains the Complete package through version 17, then adds:

- Version 18: audience decision-v2 and annual review, notification/outbox examination cursors, globally ranked matching progress, push roster plans and recovered receipts.
- Version 19: encrypted managed Auth session custody and restricted read-only predicates for current sessions and physical user absence.

The two additions were created with Supabase CLI `migration new`. They require their exact predecessor versions and install their DDL/version marker atomically. This is a 13-file chain with 87 private tables. Do not apply revision 3's competing versions 14–16 over this chain.

The selected export protocol remains Complete export-v3: immutable database snapshots, bounded chunk construction and continuation, independent write attempts, exact session-bound delivery/acknowledgement, and retirement of plaintext/hash tails. Restore remains Complete manifests-v2/computed recovery-v2 with independently recorded restrictions, effect/inventory proof and a new incarnation. Operator capability scoping and the Complete primary admin queue contracts remain active. Revision 3's audience, global matching, queue admission/repair and push roster improvements are reconciled into those contracts. `reconciliation-disposition.json` records every revision 3 backend path, including explicit replacements for its competing export/restore modules and tests.

The database runtime login must be a separate restricted role able to `SET LOCAL ROLE lovelies_api`. Keep `lovelies_api` itself `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`, without superuser/create-role/create-database/replication privileges. The migration guards reject a privileged or directly login-capable application role. Private tables use forced RLS and are not exposed to `anon` or `authenticated`.

## Managed Supabase Auth and Lovelies face authority

The backend creates real GoTrue anonymous identities and sessions through the supported Auth HTTP APIs. It does not write `auth.users`, `auth.sessions` or refresh-token internals, forge a Supabase session, or turn an anonymous identity into a permanent user by editing metadata. A managed identity remains `is_anonymous=true`; face registration, device recovery, purpose consent and current access authority belong to the canonical Lovelies account.

The existing native capability wire is preserved: the returned short-lived `access_token` still identifies the canonical account and exact app session with the established `auth_method` and `jti`. A managed Auth token is not substituted into that contract. Managed access and refresh tokens stay encrypted on the backend with AES-GCM under a distinct 32-byte key and authenticated account/binding/incarnation/session fields. Face verification can map separate managed identities to the same canonical account; revocation of an older device never grants that mapping current authority again.

Each current app request also checks its bound managed user/session through `lovelies_private.managed_auth_session_current`. The restricted security-definer function reads only the required current facts from `auth.sessions` and `auth.users`, including session presence/deadline, anonymous status, deletion and administrative ban. Its search path is fixed; public/client roles cannot execute it. Public `getUser` verification alone is insufficient for immediate session revocation, so the SQL predicate is deliberate. Local account epoch, session revocation, device revision, consent, audience and purpose checks continue to apply.

Issuance and refresh reserve a durable attempt before contacting GoTrue, then encrypt and bind its exact verified result. Auth HTTP is forbidden inside an application SQL transaction. An uncertain response remains unresolved: a refresh token is not replayed to invent success, and the local capability is not accepted without the managed binding. Logout first revokes local authority; supported logout/admin-delete APIs then retire the ephemeral managed identity. Retirement requires both provider-confirmed absence and `lovelies_private.managed_auth_user_absent`, which checks physical absence of the exact UUID in this deployment's `auth.users`. A missing or expired session, ban or soft-deleted user never proves deletion. A valid but incorrectly configured Auth endpoint cannot clear custody while the local user remains. Ciphertext and IVs remain available for cleanup, and account erasure remains blocked, until both absence checks succeed. Readiness verifies the two predicates' restricted execution grants, security-definer/search-path contract and accessibility, and rejects direct Auth table or column grants to the application role.

An uncertain anonymous signup can leave an identity whose response was lost. A private random marker and tightly bounded creation time allow the supported admin `listUsers`/`getUserById` APIs to locate a cleanup candidate. Metadata is used only for deny-only cleanup discovery, never for login, account mapping or face authority. A mapped identity, changed marker, ambiguous candidate or unqualified not-found is not deletion evidence. A scan with no match remains unresolved and continues in bounded maintenance passes. It must not be manually converted into a successful signup or completed erasure.

Managed tokens, provider identifiers, the private signup marker, ciphertext and IVs are excluded from privacy exports and restore restriction manifests. The export's managed history contains only local lifecycle facts. Backup escrow must protect the encryption key separately; a coherent application backup contains the complete Supabase database, including Auth and Storage metadata, plus the corresponding Storage bytes. The independent restore journal and push ledger have separate custody and must not be rolled back with the application.

No OTP, email/password, phone, OAuth, liveness/PAD or donor product flow is added by this integration. Ordinary enrollment pose guidance and signed capture challenges remain.

## Endpoint and TLS configuration

Use explicit deployment values; `.env.example` contains placeholders, not usable secrets.

| Variable | Contract |
| --- | --- |
| `INTERNAL_SUPABASE_URL` | Internal gateway origin, normally `http://api-gw:8000` on the private Compose network. |
| `LOVELIES_INTERNAL_SERVICE_ORIGINS` | Exact comma-separated HTTP origins permitted on the isolated network. No wildcard or implicit arbitrary HTTP fallback. |
| `PUBLIC_API_BASE_URL` | Public HTTPS URL ending exactly in `/functions/v1/lovelies-api`. |
| `LOVELIES_DATABASE_URL` | Separate restricted runtime login; URL SSL overrides are rejected. |
| `LOVELIES_DATABASE_TLS_MODE` | Defaults to `verify-full`, including on localhost. Explicit plaintext is limited to exact configured isolated hosts. |
| `LOVELIES_DATABASE_CA` | Optional trusted CA contents for verified TLS. |
| `LOVELIES_DATABASE_PLAINTEXT_HOSTS` | Exact hosts allowed only when plaintext mode is explicitly selected. |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Separate server-held Auth gateway credentials. Never native/admin client secrets. |
| `MANAGED_AUTH_ENCRYPTION_KEY` | Independently generated base64/base64url 32-byte AES key; cannot equal the app or media signing key, including decoded-byte equivalence. |
| `AUTH_SIGNING_SECRET`, `MEDIA_SIGNING_SECRET` | Existing separate Lovelies capability and media signing keys. |
| `PUSH_PROVIDER_GENERATION`, `PUSH_LEDGER_ID`, `PUSH_LEDGER_BOOTSTRAP_ID` | Exact independent push roster generation/custody pins. Production requires roster-v2. |

URLs reject credentials, query/fragment components, path traversal and ambiguous normalization. Redirects are denied. Service responses have bounded bodies and deadlines. Empty opaque Storage key defaults no longer suppress a valid configured service-role fallback.

The public proxy owns `X-Lovelies-Client-IP`: it must discard an inbound value and replace it with the actual direct peer address. Edge and gateway ports remain private. The backend never trusts arbitrary forwarded-IP headers. GoTrue anonymous signup comes from the backend gateway; its aggregate service-IP rate needs explicit staging/production load qualification. The initial deployment rate is a staging capacity setting, not a tested throughput claim. Public GoTrue routes are closed because clients use the Lovelies API.

## Delivery, jobs and negative terminal outcomes

Production push uses independently retained roster-v2 plans and receipts, generation fencing and permanent subject retirement. A recovered acceptance is historical evidence; it is never permission to send again. Legacy v1 reconciliation keeps the immutable operation/platform/token/request binding and late accepted replies, while an unbound attempted delivery remains held. Its examination loop is bounded and fair across active, retired, busy and unbound devices. Unexpected database/restore errors stop the worker; an external provider uncertainty can hold one device while other exact receipts are reconciled.

Queue admission must confirm a consumable exact job before an outbox acknowledges dispatch. A completed/failed queue identity is not silently resurrected. An administrator can inspect an exact repair fingerprint and explicitly repair only eligible pristine domain work, with current authority and external-work checks. Capability-limited operators cannot use the cross-domain queue repair route.

An exact original-request `410 operation_retired_by_recovery`, or a typed `409 operation_recovered_without_result`, is a negative terminal outcome. Clients may move the original pending operation into a durable tombstone preserving its key, digest, action and server code. They must not interpret it as success or automatically create a replacement key. A new attempt requires an explicit user decision. Current audience status alone is not a receipt. `503 audience_operation_outcome_unresolved` and `503 queue_repair_outcome_unresolved` retain the pending exact key.

## Restore operator

The canonical runtime is Node 24 or later with the workspace's locked API production dependencies (`postgres` and the Apple server-library import closure):

```sh
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs status --recovery-id UUID
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs begin --recovery-id UUID
node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs step --recovery-id UUID --steps 1
```

Run through the private operator deployment profile; no public database port is required. In addition to database, Storage and journal settings, `step` requires the managed Auth/encryption/signing settings and push pins above. `PUSH_RECOVERY_SERVICE_URL`/`PUSH_RECOVERY_SERVICE_SECRET` can select the recovery-only gateway; otherwise the configured private push service is used. Recovery invokes retirement/readback only and never admits a plan or dispatches a push.

Restore replays exact restrictions, retires old local and managed bindings, performs bounded managed cleanup outside SQL, and obtains the independent push retirement proof before repeating a proven account erasure. Each SQL phase rechecks the current independent generation and holds. A hold introduced while an external reply is pending prevents metadata erasure. Unknown signup outcomes, unsettled push attempts, missing credential custody, unknown objects and incomplete absence proof keep recovery quarantined. Clearance checks both retired managed custody and the existing Storage/effect inventory. It never reconstructs positive user/operator authority from a backup.

## Verification and remaining host qualification

The focused tests cover supported Auth HTTP shapes and failure handling, encrypted custody, immediate external session/user/ban denial, unchanged native capability binding, schema predecessor/atomicity/RLS rules, endpoint/TLS rejection, audience decision-v2, global matching, queue repair and both push protocols. Retirement regressions retain custody when a provider claims absence but the local Auth user remains without sessions, banned or soft-deleted; they also require provider confirmation after local physical deletion. Readiness regressions cover exposed, missing and incorrectly configured predicates and direct Auth table/column grants. Restore regressions exercise HTTP outside SQL, a hold appearing during a reply, unresolved signup quarantine, immutable history and exact cleanup evidence. Test-only Auth schemas/providers are clearly marked; they are not a running GoTrue acceptance test.

This workspace has no native PostgreSQL/Docker host. PGlite verifies PostgreSQL semantics but does not qualify PostgreSQL wire connections, production TLS, GoTrue issuance/rotation limits, Compose startup, HA, capacity or a physical restore. Native PostgreSQL/Deno and real disposable self-hosted Supabase acceptance remain required release gates. The existing global transaction lock is retained; measured workload capacity remains unqualified. Model implementation and synthetic matching tests do not establish field recognition accuracy, calibration or operational quality. Native device/store/push sandbox acceptance, signed application upgrades, backup/restore measurements and monitoring/incident exercises are separate evidence requirements.

Authoritative Auth references: [anonymous sign-in](https://supabase.com/docs/reference/javascript/auth-signinanonymously), [session lifecycle and revocation](https://supabase.com/docs/guides/auth/sessions), [admin list users](https://supabase.com/docs/reference/javascript/auth-admin-listusers), [admin delete user](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser), [GoTrue settings source](https://github.com/supabase/auth/blob/master/internal/api/settings.go), and [refresh-token model](https://github.com/supabase/auth/blob/master/internal/models/refresh_token.go).
