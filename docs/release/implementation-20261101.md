# Local Supabase implementation record — 1 November 2026

## Release disposition

The reviewed readiness packages have been integrated into one implementation
candidate for locally hosted Supabase. The candidate includes backend, Android,
iOS, admin, deployment, recovery and operating tooling. Source integration and
local verification do not constitute production acceptance. Actual host,
recognition-data, macOS, physical-device, provider, signing, store and operated
support/monitoring gates remain explicit in the task register.

The original review baseline is
`34b30678a64bf00933c8aeb979cccbcf622aa338`. The current source is intended for the
isolated `implementation/local-supabase-20261101` branch. The package reconciliation
and final candidate file manifest bind the selected implementation; the original
packages and old verification records remain historical evidence.

### Source coverage

| Inventory | Result |
| --- | ---: |
| Complete package paths | 226 |
| Revision 3 package paths | 276 |
| Overlapping paths | 118 |
| Unique supplied paths | 384 |
| Complete paths missing from the candidate | 0 |
| Revision 3 paths intentionally replaced | 24 |
| Current tasks preserved | 63 |
| Core release acceptance gates | 60 |
| Historical backlog items mapped | 90 |
| Review findings mapped | 43 |

Every replaced path has a concrete selected implementation and disposition in
[`package-reconciliation.json`](package-reconciliation.json). Reconciliation is
semantic: the Complete export, restore, primary-queue and native authority
guarantees were retained where Revision 3 proposed incompatible alternatives.
The readable conflict/replacement index is
[`package-reconciliation.md`](package-reconciliation.md).

## Implemented behavior

### Local platform and backend

The selected deployment uses the pinned self-hosted Supabase stack for
PostgreSQL, managed Auth, private Storage, Edge Functions and explicitly enabled
platform facilities. Public traffic passes through the configured HTTPS gateway.
Studio is restricted to the loopback administration binding; PostgreSQL,
independent custody and the inference transport are private. Runtime credentials
are generated into protected files rather than committed. A separate private
Supabase PostgreSQL custody deployment preserves journal/provider authority
across application restoration. Native PostgreSQL execution exposed and corrected
a driver boundary that serialized custody JSON twice. The storage adapter now
binds encoded JSON as text before the JSONB cast; exact stored types and
get/list roundtrips are covered in both custody namespaces. Existing malformed
authority records remain rejected and are not silently rewritten.

The additive application migration chain now ends at schema 19. It preserves
the Complete schema 14–17 contracts, adds the reconciled audience/delivery
changes at 18, and adds managed Auth custody at 19. The selected export protocol
is resumable export-v3; recovery and restore inventory retain the Complete
recovery/manifests-v2 protocols. Configuration checks, migration checksums,
least-privilege runtime admission and private bucket provisioning are explicit
operator steps.

Supported Supabase Auth APIs issue and refresh anonymous provider sessions held
only in encrypted backend custody. Lovelies independently verifies its signed
face/device authority. Neither provider anonymity nor mutable metadata can
upgrade a user to registered-face authority. Managed Auth cleanup requires both
provider absence and physical absence of the exact user from local `auth.users`.
An expired session, a ban, soft deletion or a provider pointing at the wrong
database cannot erase that custody evidence.

Global matching keeps the best and runner-up candidates across all immutable
bounded pages, with one final publication after the complete roster has been
examined. Queue repair requires fresh authorized inspection and the exact
episode fingerprint; it does not reset attempt/error history or blindly retry
ambiguous external effects. Independent push custody retains original intents,
provider generations and exact receipt ownership, including recovery-only mode.

Coordinated encrypted backup covers the application database, Auth and Storage
metadata, object bytes and required encrypted runtime recovery material. Custody
and its keys have a separate backup lifecycle. Isolated restoration keeps serving
quarantined until independent restriction/effect/object reconciliation establishes
clearance.

Managed Auth encryption-key rotation is implemented as an operator-only, guarded
workflow. It creates encrypted old/new escrow, closes a persistent serving gate,
quiesces runtime writers, atomically re-encrypts all applicable credentials and
records the independent journal transition. Verification and resumption are
separate actions. The restricted negative abort path preserves the original
operation's terminal result. Crash handling includes atomic immutable-record
publication and completed file/directory durability on retries.

### Android and iOS

Release builds now hide the development-only Android reference-screen row and
the iOS wordmark reference action while retaining ordinary branding and
accessibility. Both clients preserve `com.lovelies.memories`, existing signing lineage checks,
anonymous-first onboarding, three signed enrollment captures, registered-face
sign-in/recovery and separate purpose consents. No OTP or liveness/PAD flow was
added. Unknown/test state remains preserved; no legacy customer import is assumed.

Complete immutable Save/Share ownership, secure authority fencing, durable
export recovery and original-account store ownership are retained. Revision 3
audience decision-v2, signed renewal, local HTTPS origins, backup exclusions and
push/store recovery behavior are integrated. A proven recovered operation now
records its exact negative 409/410 outcome durably before clearing the pending
intent. A new operation requires an explicit fresh decision; token callbacks,
foreground return and generic status reads cannot silently substitute a new key.

Android push recovery migrates the old single-operation journal into a bounded
roster without losing its original identity. Store credential history prevents
purchase-token reassignment across accounts/products. iOS preserves account,
session, device-generation and public-key compare-and-swap ownership during
retirement and resumes the existing StoreKit transaction journals conservatively.

### Admin panel

The actual browser shell loads the reconciled modules and UUIDv8 records.
Responsive utility controls remain reachable at the reviewed narrow and desktop
widths. Fifteen independent operator capabilities are preserved, with
administrator-only work inspection and current eligibility/session checks.

Primary queues keep their priority/oldest ordering. Child collections and audit
history page independently with bounded cursors. Detail/action/draft results are
bound to the account, current session, generation and revision; a late response
cannot hydrate a new account after logout. Draft ownership is captured before
asynchronous persistence starts. Negative recovered audience outcomes are stored
before the original intent is cleared.

The PWA cache has a new version and an explicit public-shell inventory. Private
API payloads, tokens, drafts and account data are excluded from public caches.
The production static server receives a staged allow-list rather than a
repository-root mount.

### Release and operating controls

The release validator requires all 60 core tasks, environment-appropriate typed
qualification receipts, exact source/artifact/configuration/migration bindings,
actual artifact byte hashes, existing mobile identity/signing lineage and a
schema 19 deployment readback. It rejects generic, reused, malformed, stale or
unbound evidence. Its successful status means evidence-record completeness;
it does not independently establish observation truth or authorize launch.

The read-only platform observer reports bounded aggregate queue age/failures,
cleanup, media writers, uncertain push/Auth work, lock waits, database size and
public/private readiness. Operators must supply thresholds and assign actual
responders. Bounded read latency is clearly distinguished from mixed-write,
inference and mobile capacity qualification.

Dependency updates and pinned runtime inputs are recorded in the locked
dependency inventory. The actual backend build now performs a frozen Deno
lockfile check. Separate advisory lookups found no reported advisories in the
227-package Node workspace graph or the 49-entry Deno npm graph. These scans do
not cover the final native/mobile/container artifacts. The selected Edge runtime
uses the tracked Deno lock, but its upstream resolver can extend an incomplete
graph in memory; cold-cache, registry-denied and restart behavior therefore
remain part of actual artifact/host qualification. The observed main branch was unprotected; the required
branch rules are documented, but this environment has no repository
administration capability to apply them. CI definitions are prepared; only
actual runs on the published candidate can close the CI gate.

## Verification and its limits

The machine-readable verification record is
[`implementation-verification.json`](implementation-verification.json). It
preserves failed/superseded attempts, current focused results, exact input/log
hashes and unexecuted environments. The first full local corpus attempted all
162 suite units; it was a diagnostic run while final fixes were being integrated.
Its changing source snapshots and failures are not presented as one passing
final-candidate run. Corrected contracts and resource-interrupted units receive
distinct successor executions, with the original failures retained.

Current evidence includes actual browser/service-worker execution, embedded
PostgreSQL authorization and recovery fixtures, private HTTPS custody listeners,
Compose configuration rendering, native Kotlin host regressions, and ML
engineering tests. Separate native PostgreSQL runs verify the additive schema
under a non-superuser owner, transaction/concurrency and recovery behavior, Deno
HTTP execution, and authenticated incomplete-archive rejection. Seven additional
custody probes exercise narrow roles, independent pools, callback/client-exit
rollback, committed readback after an immediate server restart, and encrypted
archive restoration into a fresh database. These runs use a disposable generic
PostgreSQL 17.11 binary package, not the selected production container or full
Supabase/GoTrue host; host power-loss and coherent Storage/Vault recovery remain
unqualified. Embedded PostgreSQL alone does not establish those native results. Compose parsing does not mean containers were
started. A Python release guard or source inspection does not compile Swift.
Provider fixtures do not establish APNs/FCM delivery or store acceptance.

The final Android SDK run compiled the current Kotlin source, assembled both
Debug APKs, passed all 255 JVM tests, and completed lint with zero fatal findings
or errors and 59 warnings. All 288 Android input hashes matched the frozen
locale-plus-reference-control candidate. This does not establish signed Release
or connected-device acceptance.

The real ML adapter rejected this workstation's native-library layout; its guard
was retained. Actual inference requires the exact pinned image and model
qualification. Android generated-output synchronization and later memory pressure
were recorded separately from source diagnostics; the final build uses an
isolated output/cache and a guarded resource window.

## Required remaining acceptance

The detailed per-task source work, evidence scope, dependencies and remaining
acceptance are in [`local-supabase-tasks.json`](local-supabase-tasks.json). The
original acceptance criteria have not been relaxed. The unresolved environment
and operating inputs are:

1. **Target host and deployment access.** Approved domain/origins, host/storage,
   protected runtime configuration, TLS, private administration, actual migration
   and bucket readback, and independent custody volumes.
2. **Native and provider access.** A macOS/Apple SDK runner, owned Android/iOS
   devices, existing signing material/current store histories, APNs/FCM and
   Apple/Google verification inputs, and working association domains.
3. **Recognition and load qualification.** Approved representative face/media
   evaluation data, measured operating limits and mixed-workload/device budgets.
4. **Recovery and operations.** Measured RPO/RTO, backup/restore and key-rotation
   drills, named on-call/support/privacy/safety staff, actual alert destinations,
   retention/host-location policy facts and mailbox handling.
5. **Release authority and evidence.** Enforced repository checks, exact signed
   artifact readbacks, operated store review access, staging cutover/upgrade
   results and the named launch decision.

These inputs are necessary to execute the remaining acceptance, not replacement
coding tasks silently marked complete. No production deployment, store upload,
main-branch merge or launch decision is claimed by this implementation record.

### Conditional platform scope

H09 and H10 retain explicit conditional work for additional product Realtime,
Queue/vector, shared email, Google and OpenSMS integrations. The current
anonymous-first, registered-face product does not select those flows; its
unused email/phone/Google signup routes remain disabled. Those conditional
integrations and the after-rollout task are outside the 60 core release gates,
and are not reported as implemented product capabilities.
