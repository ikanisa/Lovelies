# Backend reused from MEMORIES

> **Historical source-copy phase — superseded:** These results and commands describe the
> imported MEMORIES backend before the owner's Cloudflare-only amendment.
> The current default service, anonymous enrollment authentication and fresh
> SQLite checks are documented in [the Cloudflare implementation record](cloudflare-transition.md).
> Earlier sealed evidence remains preserved; it does not verify the new port.
> On 16 October the inactive donor router, SQL and legacy tooling were removed
> from active paths and retained in a recovery archive. This document is historical;
> its feature list does not authorize current app functionality. See
> [frontend alignment](frontend-alignment.md).

The owner requested a self-contained Lovelies backend. The imported source is
the current recovered `/Volumes/T7/Recovered-G-PRO/MEMORIES` checkout, HEAD
`e373d06ce13c1e2b957622f0076a70f097ed2280`. Source selection used the actual files,
existing sharing/privacy checkpoint and current dependencies. The donor remains
unchanged; this workspace does not need its mount to run the copied code.

## Implemented reusable capabilities

| Capability | Actual implementation now in this workspace |
|---|---|
| Authentication and account authority | Worker OTP, session refresh/logout, current account and roles; shared session/revocation policies. OTP remains disabled in local defaults until independently configured. |
| Consented identity | Consent/profile contracts, current-account and identity/face gates; existing enrollment API and processing adapters. Models and actual biometric capture are separate integrations. |
| Uploads and processing | Existing personal/professional upload sessions, immutable quarantine/source binding, upload cleanup, queue leases and matching dispatch. Local R2/KV/Queues are configured without donor resources. |
| Private gallery and media | Metadata/search, signed and protected preview/download handlers, current session/consent/access and source/rendition checks. Matching a person does not create unrestricted access. |
| Reviewed sharing | Personal/professional snapshots, global/pair exclusions, exact recipient preview, versioned commit and original-key reconciliation. Commit creates pending requests; recipient acceptance revalidates the exact subset. |
| Privacy | Shared export inventory, approved-request execution leases, account erasure, counterpart graph redaction and independent completion checks. Unaffected approvals and policy-retained financial/cleanup evidence are preserved. |
| Billing and operators | Existing Apple/Google entitlement verification, web-only payment boundary, support/moderation/admin and operational handlers. Target provider credentials/product identities are required; local defaults disable external checkout. |
| Client seam | `clients/backend/client.mjs` provides real API calls, bounded protected bytes, account/epoch fences, exact review guards and token-free recoverable operation intents. [Client contract and usage](backend-reuse-client.md). |

The Worker, shared contracts and Edge helpers preserve their relative dependency
layout. This is a complete source assembly for these service boundaries, rather
than copying isolated snippets. The source includes existing capabilities whose
provider/device operation remains unverified. The Android/SwiftUI/browser screen
catalogues retain their current designs and explicit fixture stores; they have
not been silently switched to live accounts or assigned fake bearer tokens.

## Local configuration and actual commands

Node 24 and pnpm 10.33.2 are used with the donor's pinned resolved dependencies.
The initial install succeeded offline without executing dependency install
scripts. The checked-in lockfile covers this backend workspace.

```sh
pnpm install --frozen-lockfile
pnpm backend:typecheck
pnpm backend:test
pnpm backend:client:test
pnpm backend:sql:test
pnpm backend:schema:check
pnpm backend:build
pnpm backend:dev
# From a second terminal while the local API is running:
pnpm backend:smoke
```

`services/api-worker/wrangler.jsonc` has loopback URLs and newly named local
R2/KV/queue/workflow/image/analytics/rate-limit bindings. It has no donor routes,
project identifiers, credentials, scheduled provider work or production
environment. Its compatibility date is **2026-07-21**, the newest date supported
by the cached pinned workerd binary; the donor's 2026-08-09 failed local startup.
No dependency upgrade or donor configuration change was made to resolve that.

`backend/local-entry.ts` delegates application operations to the actual Worker.
It adds truthful process health, explicit unavailable readiness for missing
private configuration and configured-origin CORS. It rejects other browser
origins before operations. `/health` does not claim a successful database probe,
ML/provider readiness or actual delivery. `/ready` remains unavailable with the
checked-in defaults. `backend:build` uses Wrangler **dry-run**, never deployment.

The empty `services/api-worker/.dev.vars.example` names the private local
configuration fields. Supply independently owned values in an ignored
`.dev.vars` only when the compatible database and services are ready. Provider
credentials, accounts, photographs, biometric profiles, caches, generated
deployment state and the donor's hosted configuration were excluded.

The preview server at `scripts/serve-preview.py` serves only the public preview,
image/reference assets and public client files. The existing screenshot page
and paths are preserved; backend configuration and directory listings are not
part of its public surface.

## Verification and limits

Fresh target results and exact source/log/bundle hashes are recorded in
[the backend verification binding](../verification/backend-reuse/final-results.json).
Tests run against the copied target, not against the donor. The selected SQL
runner executes actual application function fragments and all six additive
sharing/privacy migrations in isolated fixtures. It does not establish a full
empty-database/provider-schema replay.

| Executed check | Actual result |
|---|---|
| Worker TypeScript | Clean, exit 0, including the new adapter and compatible-client cases. |
| Worker suite | **1,258 passed, 0 failed/skipped, 28 files**. Includes three actual SDK → Worker handler cases: real signed OTP token/current account, exact personal subset/lost-response reconciliation and professional batch/source behavior. Provider/database ports in those cases are synthetic. |
| Reusable client | **22 passed**: scope/graph checks, account/epoch cleanup, original-key recovery, errors, media bounds and actual loopback HTTP transport. |
| Edge/shared | **712 passed** after copying the two omitted QA helpers. |
| Matching / atomic helpers | **262 / 81 passed**, respectively. |
| SQL | **293 PostgreSQL-WASM / 299 native PostgreSQL assertions passed**; all six additive migrations in the stated selected-schema fixture. The native concurrent case passed, and the disposable container was removed. |
| Local bundle | Wrangler 4.112.0 dry-run build passed; `verification/backend-reuse/worker-build/local-entry.js` and its source map are retained. No deployment occurred. |
| Actual local API HTTP | **10 checks passed** on workerd: process health, unavailable readiness, protected-route denial, disabled unconfigured OTP, allowed/denied CORS and unknown route. |
| Schema inventory | Default check exits **0** with source integrity verified and `provider_ready=false`; strict readiness exits **2** on the recorded history/provider gates. Six behavior tests passed. |
| Preview serving | Six real HTTP security/asset tests passed; six current-server asset/config-denial readbacks also passed. The readbacks repeat serving behavior and are not extra unique coverage. |

These cohorts overlap; their counts are not added as unique coverage. The local
API runs at `http://127.0.0.1:8787`, and the guarded preview runs at
`http://127.0.0.1:8765/preview/index.html`. Both are development processes.
The 405 unique imported files are source/tests/schema; copied file counts do not
establish hosted acceptance. Native/browser source and reference assets remain
unchanged in the recorded preservation set.

The initial Worker checks retained two failed local-adapter assertions; the
gallery route was corrected to `/me/gallery`, and permissive development CORS
was fixed in the local adapter. The first Edge run failed because two Python
QA helpers were omitted from its dynamic fixture closure. Both exact helper
files were added; the initial failure is retained separately. These were source
assembly/local integration repairs, not weakened authorization assertions.
The new compatible-client fixture initially omitted the required OTP country
policy, then asserted an older boolean JWT-library result. It now uses explicit
synthetic country policy and checks the actual verified signature/payload,
including rejection of a tampered payload. The preview HTTP test helper was
also corrected to close Python 3.12 connections correctly. All failed runs and
their source preimages remain separate from the final passing results.

The complete historical schema remains gated by a duplicate migration version
and missing authoritative full-provider DDL. The read-only schema inventory
passes when the copied inputs are intact while reporting `provider_ready=false`;
`--require-ready` exits **2**, intentionally. [Exact schema prerequisites and
apply order](backend-reuse-schema.md) are retained. No history file was deleted,
renamed or reordered, and no database was automatically migrated.

For rollback, stop the new local entrypoint first and use the import manifests
to identify only the new source. Do not weaken approval/origin/managed-gallery
or privacy guards in any subsequently configured database. Preserve existing
authorization and history, and follow the schema notes for reviewed deployment.

Remaining work is actual target database/provider configuration and replay,
ML/model/store acceptance and native client integration, followed by physical
device/platform and hosted cross-account acceptance. Existing visual and iOS/
Android qualification limits remain in the earlier implementation report.
No deployment, provider message, production migration, commit or push occurred.
