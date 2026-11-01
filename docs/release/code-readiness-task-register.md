# Lovelies — complete local implementation task register

Prepared 29 October 2026; updated 30 October 2026 for `ikanisa/Lovelies`, against commit
`34b30678a64bf00933c8aeb979cccbcf622aa338`.

## What this complete package delivers

This is a source integration package for the existing repository. It contains
the full contents of every changed/new file, a Git patch, regression sources,
verification logs, a hash manifest and a guarded application script. It adds no
new npm, Maven or Swift package dependency. Existing project dependencies and
the normal platform toolchains are still needed to build the applications.

**It does not establish production readiness.** The tables below describe
specific code tasks completed in this package, rather than claiming every
original review finding is closed. Backend/admin behavior has local automated
evidence. The latest clean Android SDK build compiles the debug application and
instrumentation APK and passes all 252 JVM regressions, with zero failures,
errors or skips. A fresh controlled Android host run separately passes 69 cases
with 32 stable recorded inputs, explicit platform fakes and real host directory
sync. Final lint passes with zero fatal issues, zero errors and 66 warnings.
The corrected APKs pass three offline instrumentation invocations on an owned
API-24 software emulator: eight checks with WRITE permission denied, eight with
WRITE granted, and three EN→RW→EN loading-component stages.
Preserved native
PostgreSQL and Deno checks pass, and all 47 active Swift files pass syntax
parsing in ordinary and DEBUG configurations. Apple SDK typechecking/builds and
Swift/XCTest execution remain unverified in this environment. Actual device,
hosted-service, provider and store acceptance remain separate work.

The 45 task numbers below are this package's implementation items; they are
not the repository's historical production work packages. This complete edition
includes the original 33 tasks and implements all six local engineering areas
listed as unfinished in the first handoff, plus the companion iOS journal work.
The 30 October continuation adds five concrete admin, accessibility and Android
storage corrections as T41–T45. Original review
IDs are included for traceability. `VERIFICATION.md` gives actual commands,
counts and limitations; `manifest.json` is the complete file inventory.

## Backend and shared API tasks included

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T01 | Recoverable, session-bound export delivery v2: retain one creation identity, repeat authenticated retrieval after transport loss, acknowledge verified durable staging with a separate key, then retire the publication. Keep the legacy one-use route. | `services/supabase-api/src/privacy-export-delivery.ts`, `private-body.ts`, `privacy.ts` | AND-04, IOS-04, part of BE-12 |
| T02 | Preserve attempted/ambiguous push history through opt-out, token retirement, device removal and logout. Reconcile original-request-bound late provider receipts without restoring permission to send. | `services/supabase-api/src/notifications.ts`, `services/push-provider/src/ledger.mjs` | BE-05 |
| T03 | Make durable queue handoff depend on actual domain state. Re-arm completed/failed queue rows when work remains, preserve current leases/backoff, reject unknown states and revisit stranded outboxes. | `services/supabase-api/src/jobs.ts`, `processing.ts`, `notifications.ts`, `privacy.ts` | BE-06 |
| T04 | Capture candidate profiles in bounded immutable batches, resume processing beyond 1,000 profiles, recheck consent/profile/audience authority, exclude new arrivals and publish only after every batch agrees. | `services/supabase-api/src/processing.ts`, schema-14 migration | BE-03; capacity remains BE-07 |
| T05 | Enforce account in-flight, reserved-source-byte, rolling daily byte/reservation and processing-attempt budgets. Missing/malformed capacity configuration fails readiness and admission. | `services/supabase-api/src/upload-budgets.ts`, `index.ts`, `types.ts`, Edge entrypoint | Part of BE-08 |
| T06 | Add complete account-scoped notification pagination and authorized lookup by notification ID for older push taps. | `services/supabase-api/src/account-pagination.ts`, `notifications.ts` | IOS-11 and Android integration |
| T07 | Add stable cursor pagination for incoming and outgoing sharing histories, bound to account and collection. | `services/supabase-api/src/sharing.ts`, `account-pagination.ts` | IOS-11 and Android integration |
| T08 | Add explicit authorized photo-ID lookup so Favorites can retrieve saved IDs outside previously loaded gallery pages. | `services/supabase-api/src/gallery.ts` | IOS-10 |
| T09 | Add schema 14 with forced-RLS/backend-only tables, immutable delivery binding checks and queue metadata; integrate new records into export metadata, erasure/redaction and retention. | `supabase/migrations/20261029120000_delivery_reliability.sql`, `schema.ts`, `privacy.ts`, `retention.ts`, migration/lifecycle tests | Supports T01–T05; part of BE-12 |

## Admin panel tasks included

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T10 | Replace loaded-row filtering with server search/status filters and stable pagination for support, privacy, guardians, uploads and safety collections. Show complete matching counts and prioritize unresolved work. Keep safety reports and matching proposals independently pageable. | `admin/live-queues.mjs`, `admin/live-app.mjs`, `services/supabase-api/src/admin-pagination.ts`, `operators.ts`, `audience.ts`, `privacy.ts` | ADM-01 |
| T11 | Show attributable support decisions, revisions and rationale from retained immutable operation receipts. Verify each receipt binding/hash, paginate history and expose the retention boundary explicitly. | `services/supabase-api/src/operators.ts`, `admin/live-app.mjs` | Scoped implementation of ADM-02 |
| T12 | Expose upload processing attempts, queue/outbox state, attempts, handoffs, lease age/error codes and moderation holds without private image bytes, object keys, lease tokens or raw payloads. | `services/supabase-api/src/operators.ts`, `admin/live-app.mjs` | Diagnostic portion of ADM-03 |
| T13 | Update the service-worker cache version/precache and the restricted local-preview allowlist for the new queue module and required audience module. | `admin/sw.js`, `scripts/serve-preview.py`, associated tests | Supports ADM-01/05 |

T11 uses existing immutable receipts and their existing retention policy.
T38 now extends T12 with reviewed recovery of an eligible original processing
attempt. The diagnostics explain why ineligible work needs a fresh owner action
or external reconciliation. Historical records outside retention are not
reconstructed.

## Android tasks included

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T14 | Bind Save/Share to the original photo/source, account, session, device and viewer action. Preserve the intended action through permission/Billing callbacks; reject stale route, pager or account results. | `PhotoActionOwner.kt`, `LiveController.kt`, `LiveScreens.kt` | AND-01 |
| T15 | Reconcile FCM token rotation on authenticated startup/foreground. Retain a dedicated encrypted push journal and verify typed operation receipts; preserve a newer concurrent token generation and unknown outcomes. | `PushOperationRecovery.kt`, `PushMessaging.kt`, `CloudflareRepository.kt`, `LiveController.kt` | AND-02 |
| T16 | Reflect runtime permission, app notification permission and channel state correctly. Route OS-disabled cases to Settings and distinguish unconfirmed backend changes from successful enablement. | `PushMessaging.kt`, `LiveScreens.kt`, EN/RW resources | AND-03 |
| T17 | Implement export v2 with durable creation/ACK identities, verified encrypted staging, expiry/session/chooser binding, restart recovery and finite owned-byte cleanup. | `PrivacyExportDelivery.kt`, `CloudflareRepository.kt`, `LiveController.kt`, `LiveScreens.kt` | AND-04 |
| T18 | Archive a completed account-A purchase under A before account B's distinct purchase. Retain unresolved holds, original ownership and ambiguous replacement-write evidence; never transfer entitlements. | `StorePurchaseRecovery.kt`, `CloudflareRepository.kt`, store boundary tests | AND-05 |
| T19 | Give new supported camera/share temporary files durable ownership records and exact file identities. Serialize supported writers/cleanup, retire stale handoffs and preserve unknown or replaced paths. | `OriginalMedia.kt`, `LiveController.kt`, private-media tests | AND-07 |
| T20 | Consume all pages of support, notifications and sharing histories, with Load more, cursor validation and current-account/session publication checks. Use notification-ID lookup for old taps. | `LiveController.kt`, `LiveScreens.kt`, account-page parser and tests | Cross-client completion for T06/T07/T10 |

Android paths above are relative to
`android/app/src/main/java/com/lovelies/frontend/preview/`, except resources
and tests. The full debug application and instrumentation sources compile
against Android SDK 36, and the actual Gradle JVM suite passes all 252 cases.
The separate host harness exercises selected pure logic and controlled
filesystem boundaries. Compilation is separate from the API-24 emulator
execution recorded in the current verification addendum. That offline scope
covers selected installed platform operations and the T44 loading component;
full camera/upload, document-provider, Play Billing, actual FCM, physical
Keystore, restart and power-loss journeys still require their own qualification.
The package implements AND-06 through T36.

## iOS tasks included

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T21 | Use a typed Apple purchase journal and verified-submission recovery. Keep transaction submission identity separate from the latest entitlement; retain finish phases and migrate supported legacy intents. | `CoreWire.swift`, `BackendRepository.swift`, `NativeServices.swift` | IOS-01, IOS-03 |
| T22 | Preserve the original mutation identity when a successful write is followed by an audience change. Merge/remove exact generic intents using compare-and-swap rather than overwriting other evidence. | `BackendRepository.swift` | IOS-02, part of IOS-06 |
| T23 | Preserve uncertain generic/upload evidence through retirement; delete only an exactly owned credential. Close in-memory publication immediately before vault waits, reject late credential writes, and surface unconfirmed durable retirement. | `BackendRepository.swift`, `LiveAppStore.swift`, recovery tests | IOS-06, with native/concurrency qualification pending |
| T24 | Implement export v2 creation, protected staging and distinct acknowledgement phases. Reconcile lost create/GET/ACK replies while checking original session, expiry, byte length and digest. | `CoreWire.swift`, `BackendRepository.swift`, `LiveAppStore.swift` | IOS-04 |
| T25 | Fence privacy, export and destructive-action presentation so late responses cannot repopulate a retired account/session or dismissed operation. | `LiveAppStore.swift`, release regressions | IOS-05 |
| T26 | Bind gallery state/cursors to the full query and process the latest search after a slower request. Clear query-specific results when leaving search. | `LiveAppStore.swift`, `LiveOnboardingAndGallery.swift`, release regressions | IOS-08, IOS-09 |
| T27 | Load Favorites by stable saved IDs through the authorized lookup endpoint instead of searching loaded gallery pages. | `BackendRepository.swift`, `LiveAppStore.swift` | IOS-10 |
| T28 | Page notifications, support and sharing histories, and resolve notification taps through authorized ID lookup. | `BackendRepository.swift`, `LiveAppStore.swift`, `LiveSharingAndSettings.swift`, `NativeSettingsPanels.swift` | IOS-11 |
| T29 | Reject missing/non-public/non-HTTPS Release policy/support URL inputs and require valid policy/terms inputs before purchase UI activation. Include tests and a macOS host-test command. | `ios/scripts/check_release_policy_urls.py`, Release configuration/project, `ios/Tests/`, native UI | Configuration guard for IOS-07, part of REL-04 |

iOS Swift filenames above are under `ios/Lovelies/Native/`. Swift/XCTest
regressions are supplied but were **not executed here**. The Swift 6.4.1 Linux
frontend performed 94 successful syntax-only parses across all 47 active files,
using Swift language mode 5, with and without DEBUG. This does not typecheck
Apple APIs, validate actor isolation or execute the test assertions. The Python
Release configuration tests were executed. Correct URL structure does not prove that
the pages are live, approved or accurate; no invented production URL was
substituted. Physical Keychain lock/failure, reboot, concurrent background
instances, APNs, StoreKit and document-provider behavior remain qualification.

## Repository and handoff tasks included

| Task | Implemented result | Files | Review mapping |
|---|---|---|---|
| T30 | Add Android debug/JVM/instrumentation-compilation/lint and iOS simulator-compile/Foundation-host CI lanes using pinned action commits, read-only repository permissions, retained JVM/lint reports and no deployment or release-signing step. | `.github/workflows/native-readiness.yml` | Code portion of REL-05 |
| T31 | Add sequential local verification with strict actual test-summary checks, source/log hashes, explicit failures and portable evidence; add a service CI lane and update the isolated Edge harness for schema 17, all eleven canonical migrations through that schema and fixture budgets. | `scripts/verify-readiness-package.mjs`, `.github/workflows/service-readiness.yml`, `scripts/test-isolated-supabase-edge.mjs` | Code portion of REL-05/06 |
| T32 | Pin the official Gradle 8.13 distribution checksum. | `android/gradle/wrapper/gradle-wrapper.properties` | Scoped improvement to REL-08 |
| T33 | Deliver the complete source overlay, patch, hash manifest, task register, integration instructions, verification index and an application script that rejects changed target files or the wrong base commit. | Package root, `repo-files/`, `evidence/` | Handoff and REL-06 |

Workflow files are not passing Actions runs. Existing GitHub billing/required
checks and branch-protection decisions were not changed. The Gradle checksum
does not establish verification of every transitive build dependency, license
or final signed binary.

## Remaining local work now implemented

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T34 | Complete the recovery protocol in code: reconcile accepted prepares after SQL rollback into a distinct restrictive outcome; replay exact restrictions; fence old writers; record independent external effects; scan all private namespaces; require exact cleanup/absence and hold checks; compute clearance before installing a new serving incarnation. Supply an environment-driven operator CLI and runbook. | `services/restore-journal/src/{effects,reconciliation,recovery}.mjs`, `services/supabase-api/src/restore-*.ts`, Storage/service adapters, schema-15 migration, recovery CLI | BE-02 |
| T35 | Replace the 32-fact refusal with immutable versioned manifest roots, complete counts and bounded continuation pages. Preserve original operation/input identity, v1 compatibility, crash/reply-loss recovery and every selected restriction. | `services/restore-journal/src/manifests.mjs`, `restore-manifest.ts`, `restore-journal.ts`, `restore-transaction.ts`, restrictive producers and regression fixtures | BE-04 |
| T36 | Complete Android authority retirement with a nonblocking publication gate, a separate encrypted monotonic ledger and generation/credential checks across auth, refresh, logout, deletion and recovery writers. Reject late old snapshots on restart and handle retirement before cold-start credential loading. | `SessionAuthority.kt`, `SecureSession.kt`, `CloudflareRepository.kt`, `LiveController.kt`, authority regressions | AND-06 |
| T37 | Complete iOS authority and journal concurrency work: independent monotonic Keychain ledger, per-slot compare-and-swap locks, durable challenge/refresh reservations, exact journal replacement and guarded device-key/reference cleanup. Preserve uncertain evidence while stopping old account publication. | `DeviceIdentity.swift`, `CoreWire.swift`, `BackendRepository.swift`, `LiveAppStore.swift`, `NativeReadinessRecoveryTests.swift` | IOS-06 |
| T38 | Add safe operator processing recovery: independent current operator, exact reviewed revision, fresh face authority, current source/session/model/consent/audience, no active lease/hold/unresolved writer, exact Storage metadata and a three-per-attempt/day budget. Resume the original attempt/job, retain backoff/history and return an idempotent receipt. | `operator-recovery.ts`, `operators.ts`, `admin/live-app.mjs`, recovery/retention regressions | ADM-03 |
| T39 | Add 15 explicit delegated operator capabilities with full-admin-only independent provisioning, read prerequisites, maximum 30-day expiry, expected revision and immutable grant episodes. Gate every affected route, receipt replay, generic operation lookup and admin control using current database authority. Include revocation, erasure, restore and retention handling. | `operator-capabilities.ts`, `operator-access.ts`, schema-17 migration, `clients/backend/operator-capabilities.mjs`, admin integration and authorization matrix tests | ADM-04 |
| T40 | Add large export v3 end to end: one atomic SQL metadata snapshot, resumable 1 MiB chunks, incremental SHA-256, paged manifests, current-session delivery and durable ACK. Android stages encrypted chunks; iOS streams protected file assembly. Every PUT attempt has its own immutable cleanup identity, including late writes. Retain small-export v2 compatibility and integrate holds/erasure/retention. | `privacy-export-{catalog,chunks,schema,delivery}.ts`, `incremental-sha256.ts`, schema-16 migration, `ChunkedPrivacyExport.kt`, native repository/store integration, export regressions | BE-12, AND-04, IOS-04 |

## Additional local corrections implemented on 30 October

| Task | Implemented result | Principal files in `repo-files/` | Review mapping |
|---|---|---|---|
| T41 | Bind asynchronous admin detail/history reads to their navigation, account, session and request owner. Dismissal, Escape, native close, logout and backgrounding retire the read. Track the displayed dialog separately so delayed close events cannot cancel a newer selection, and late history cannot reopen a dismissed record. A dismissed request that discovers actual authority loss still clears private workspace data. | `admin/live-app.mjs`, `admin/live-app.test.mjs` | ADM-02/03/05; follow-up to T11/T38 |
| T42 | Make the admin skip link prevent its default fragment navigation and focus the current workspace while preserving its route, search/filter selection, records and browser history. | `admin/live-app.mjs`, `admin/live-app.test.mjs` | ADM-01; REL-03 keyboard accessibility |
| T43 | Retain the exact pending operator intent until durable cleanup succeeds. Capture an independent canonical copy of caller input, serialize actions, and publish a cleared journal only for the same credentials, account, epoch, action owner and unchanged complete state. Preserve pending recovery evidence on cleanup failure or concurrent/newer state; reject late publication after logout. | `admin/operator-session.mjs`, `admin/operator-session.test.mjs` | ADM-03/04/05; recovery support for T38/T39 |
| T44 | Reuse the existing English/Kinyarwanda loading state in a shared production progress indicator at all four live-screen call sites. Preserve contextual labels, Material indeterminate semantics, size, color, stroke and layout. Supply an opt-in offline instrumentation probe for EN→RW→EN recomposition and exported accessibility nodes in an explicitly owned disposable debug Activity. | `LiveScreens.kt`, Android test manifest, `LoadingAccessibilityJourney.kt` | REL-03 localized accessibility; scoped REL-02 component verification |
| T45 | Fix the production temporary-media directory-sync failure discovered on API 24. Replace directory `FileChannel` opens with supported public Android `Os.open`, descriptor-type validation through `fstat`/`S_ISDIR`, mandatory `fsync` and descriptor closure. Preserve no-follow checks, ownership durability before private bytes, and failure cleanup limited to the exact creation. Add two JVM regression methods for failures at all three sync boundaries and preservation of a same-path replacement. | `OriginalMedia.kt`, `PrivateMediaRetentionTest.kt`, host media fixture and `scripts/test_android_push_optout.py` | AND-07 temporary-media ownership; REL-02 platform compatibility |

The final admin suite passes **116 cases**, including **13 new regression
cases** across the controller and durable-action fixtures. The shared-client
suite separately passes **53 cases**, including its real loopback HTTP fixture.
The admin controller uses a synthetic DOM harness; the storage tests use
`fake-indexeddb` and real WebCrypto. They do not establish actual browser,
camera, multi-operator or hosted acceptance. The service-worker cache advances
to `20261030-readiness-3` so the corrected source participates in the existing
explicit update-activation flow.

The Android test README now describes the eleven canonical migrations through
schema 17. Its documentation-only delta after the initial 30 October build is
preserved as historical evidence, including that checkpoint's 279 other unchanged
inputs. The latest clean build includes the corrected README and the T45 media
fix in its own stable 280-input snapshot. This documentation correction is not a
new migration or an additional numbered product task. No new npm, Maven or Swift
package dependency was added.

### Recovery consequences and exact boundaries

An ordinary failed commit is reconciled by applying only the original exact
restrictive facts. Its callback is not replayed and no original success receipt
is fabricated. A still-authorized caller receives a terminal recovered-operation
response; a caller whose own authority was retired is denied by authentication.
New positive work needs a new authorized user action.

A full database restore retires restored session/device/profile/consent/recovery
and operator authority before reopening. The implementation does **not** treat
restored face rows as independent proof that an old account can be reactivated.
Existing private data remains inaccessible until an independently qualified
same-account recovery mechanism is available. Fresh anonymous accounts can use
the normal enrollment flow. Unknown external writes and active holds continue
to block clearance. These are explicit operational consequences, not a claim
that a real disaster recovery exercise or existing-user re-entry was accepted.

The new capabilities are a concrete least-privilege policy supplied in code:
15 named permissions, paired read permissions for changes, explicit expiry of
at most 30 days, no self-granting and no delegated delegation. Production staff
selection and independent administrator provisioning remain operational work.

## All 43 review findings: remaining scope

| Original finding | Package coverage and what remains |
|---|---|
| BE-01 | Application hosting, configured service inputs and serving admission are not established by this package. No restore bootstrap or API deployment performed. |
| BE-02 | T34 supplies the recovery controller, exact restriction/effect capture, replay, cleanup and computed clearance. Independent journal custody/deployment, actual Storage acknowledgement semantics and a hosted restore rehearsal remain. Existing-account re-entry after full authority retirement requires independent qualification; see the consequence above. |
| BE-03 | T04 removes the fixed 1,000-profile rejection through resumable bounded batches. Actual large-population request time, lock contention and model cost remain capacity acceptance. |
| BE-04 | T35 implements complete manifests above 32 facts with bounded transport continuations and failure/reply-loss tests. Hosted transaction size, request budgets and large-population performance remain capacity qualification. |
| BE-05 | T02 plus focused prior/new local regressions. Private gateway deployment and real provider races remain acceptance. |
| BE-06 | T03 plus local queue/outbox regressions. Actual scheduler operation and hosted backlog monitoring remain. |
| BE-07 | Hosted concurrency/load/cost measurements and accepted operating budgets remain. |
| BE-08 | T05 supplies configurable account source/admission budgets. Production values, trusted proxy/IP provenance, whole-provider resource/cost accounting and abuse/load acceptance remain. |
| BE-09 | Permissioned representative recognition evaluation and approved thresholds remain. |
| BE-10 | Store credentials, callback routing and actual purchase/refund/restore lifecycle acceptance remain. Mobile recovery code is included. |
| BE-11 | Push history/queue/mobile recovery code is improved; private host/custody/configuration and actual APNs/FCM device delivery remain. |
| BE-12 | T01/T09/T34/T40 implement v2/v3 delivery, large snapshots/chunks, new-record retention/erasure, exact delayed-write cleanup and restore integration. Operated deadlines, real processor/backup custody and hosted/device acceptance remain. |
| AND-01 | T14 source and selected host tests; native permission/Billing/pager/save/share acceptance remains. |
| AND-02 | T15 source and selected host tests; full native adapter and real token/provider lifecycle acceptance remains. |
| AND-03 | T16 source and selected host tests; actual OS Settings/channel/notification behavior remains. |
| AND-04 | T01/T17 source and host recovery tests; full Android protected-storage/document-provider integration remains. |
| AND-05 | T18 source, host archive tests and actual repository JVM boundary tests pass; native store flow remains. |
| AND-06 | T36 implements the independent retirement ledger and publication/CAS generation boundaries, including cold-start and blocked-writer regressions. Actual Keystore, filesystem, process-kill and power-loss qualification remain. |
| AND-07 | T19 covers all new supported temporary writers, and T45 corrects the directory-sync incompatibility found on API 24 with exact-ownership failure regressions. The corrected code passes the owned API-24 private-file and FileProvider checks in both WRITE-permission branches. Physical filesystem/power-loss/recipient behavior remains; unknown legacy files are preserved. |
| IOS-01 | T21 source/tests supplied; Swift/native execution remains. |
| IOS-02 | T22 source/tests supplied; Swift/native execution remains. |
| IOS-03 | T21 source/tests supplied; actual StoreKit lifecycle remains. |
| IOS-04 | T01/T24 source/tests supplied; Swift/native protected-storage/provider execution remains. |
| IOS-05 | T25 source/tests supplied; Swift/MainActor regressions and device execution remain. |
| IOS-06 | T22/T23/T37 implement the authority ledger, exact journal CAS, challenge reservations and guarded key/reference cleanup. Swift compilation, Keychain lock/failure/restart and native concurrent-instance qualification remain. |
| IOS-07 | T29 prevents an invalid Release configuration. Actual approved published privacy, terms, support and deletion endpoints remain required. |
| IOS-08 | T26 source/tests supplied; Swift/native execution remains. |
| IOS-09 | T26 source/tests supplied; Swift/native execution remains. |
| IOS-10 | T08/T27 source and backend checks; Swift/native execution remains. |
| IOS-11 | T06/T07/T28 source and backend checks; Swift/native execution remains. |
| ADM-01 | T10 server/UI/local regressions; actual hosted concurrent operator/browser acceptance remains. |
| ADM-02 | T11 supplies verified history within existing receipt retention. A separate event store or different history-retention policy is not implemented. |
| ADM-03 | T12/T38 supply diagnostics and reviewed, bounded, revision-bound recovery of an eligible original attempt. Unknown external effects, current holds and expired/changed original authority correctly remain ineligible. Hosted scheduler/operator acceptance remains. |
| ADM-04 | T39 implements the concrete capability policy, provisioning/revocation UI/API and authorization matrix, including cached/generic receipts. Staff assignment, administrator custody and hosted multi-operator acceptance remain. |
| ADM-05 | Hosted independent operator provisioning and actual browser/camera/storage/service-worker acceptance remain. |
| REL-01 | Signed replacement artifacts, store validation and real in-place upgrades remain. |
| REL-02 | The corrected APKs pass the scoped offline API-24 platform/component checks described below. Full supported-device journeys and interruptions remain. |
| REL-03 | EN/RW copy and T42/T44 keyboard/progress corrections are included. The current report records the exact locale/node probe scope; spoken screen-reader acceptance, broader localization review and release-performance acceptance remain. |
| REL-04 | URL guards/documentation help; final notices, declarations, screenshots, reviewer access and store decisions remain. |
| REL-05 | T30/T31 supply workflow source; remote execution, billing resolution, required checks and branch rules remain. |
| REL-06 | T31/T33 supply portable evidence for this package only. Historical missing external artifacts and final signed-candidate evidence remain. |
| REL-07 | Accepted operational owners, alert routing, incident/restore exercises and rollout observation remain. |
| REL-08 | T32 supplies wrapper integrity. The local Android debug run records its exact JDK/SDK/compiler inputs and output hashes. Full dependency/build-input assurance, Apple SDK qualification and signed-release artifact inspection remain. |

## Preserved 29 October platform qualification

The preserved baseline has 134 verified catalogue rows, including 2,196 passing
TAP cases, 11 Python tests and a backend typecheck, plus 69 controlled Android
host cases. Its two declared native PostgreSQL skips remain visible in that
historical evidence. The additional native run passes those two cases and 14
previously excluded cases: 15 PostgreSQL cases and one actual Deno entrypoint
case. These are separate, recorded executions, not a claim of one immutable
full-platform test run.

The native database checks use a newly owned PostgreSQL 17.6 cluster with
fsync, synchronous commit and full-page writes enabled. They cover schema
7–17 migration through 81 private tables, non-superuser migration permissions,
forced RLS, independent-pool concurrency, exact restrictive restore replay,
refresh cancellation/delivery races and cleanup coordination. The Deno 2.9.6
entrypoint runs against that local database and an HTTPS journal fixture. It
correctly remains unready without qualified Storage, model and provider services.
The Deno frozen-lock typecheck also passes without a dependency or lockfile
change. Every owned database process was stopped and fixture databases/roles
were cleared after the final checks.

Three native fixtures were updated to reflect the completed schema and recovery
contract: `postgres-migration.test.mjs`, `restore-postcommit-runtime.test.mjs`
and `deno-entrypoint.test.mjs`. Its 94 Swift parser checks are described above.
These database/parser results remain a preserved checkpoint; the later Android
corrections are separately recorded rather than relabelling the old source state.

The actual Android build uses Temurin 17.0.21+9, Gradle 8.13, Android platform
36, build tools 35.0.0/36.0.0 and the repository's declared Kotlin 2.2.20/AGP
8.13.0. Both debug APKs compile, and a fresh `--rerun-tasks` invocation executes
all **250 JVM cases with zero failures, errors or skips**. The fresh controlled
host run separately passes all 69 cases. Instrumentation compilation contributes
zero executed device tests; the source handoff includes APK hashes, not APK bytes.

That full compilation and JVM run uncovered and corrected actual integration
issues. `CloudflareRepository.kt` now checks the action response against the
correct request payload, reads the Android monotonic clock only when a live
export needs it, and retains the exact completed guest-deletion hold if a local
restart loses its write acknowledgement. `SessionAuthority.kt` can repair its
private compare-and-swap baseline after an ambiguous write only when the disk
contains the exact before/attempted bytes and the same current authority scope.
It does not publish credentials or overwrite competing state to recover.

Six added JVM regressions cover ambiguous save/readback outcomes, competing
content, retired generations and guest-intent conflicts. Existing phase tests
now exercise immediate authority retirement and rejection of late publication.
The API-24 fixture consumes the current sharing result and retires only exact
owned media handles. Generated Kotlin session caches are excluded from Git.
The CI definition now retains instrumentation compilation and lint alongside
the app/JVM checks; a remote Actions run is still a separate gate.

Static-analysis follow-up adds explicit cloud-backup and Android device-transfer
exclusions for all nine app-data domains, retains disabled legacy backups, and
prevents the shared repository from retaining an Activity or ContextWrapper.
The constructor still copies the explicitly supplied vault storage namespace,
so isolated native fixtures retain their own private files. Twenty Compose
resource reads now track configuration changes, and the animated toggle reads
its offset during placement. The existing English/Kinyarwanda selection labels
remain deliberate, documented Compose accessibility resource overrides; the
installed Compose library has no Kinyarwanda selection resources. Those private
resource names and translations must be rechecked when Compose is upgraded.
The existing layout thresholds and copy are unchanged. Static warnings and
unexecuted device/accessibility journeys remain explicitly recorded.
That checkpoint's final lint command passed with **zero errors/fatal issues and 67 warnings**,
down from the initial 94. No global warning suppression or lint baseline was
added; the two selection-string overrides are individually documented. The
remaining diagnostics and their limits are included in the handoff review.

`VERIFICATION.md` contains the commands, source/log hashes, preserved failed
attempts and exact qualification limits. Portable PostgreSQL, a local Deno
process, Android compilation/JVM tests and Linux Swift parsing do not establish
hosted Supabase, physical restore, Apple SDK or device acceptance.

## 30 October verification follow-up

The latest clean SDK run, recorded in
`android-build-media-sync-final-20261030/result.json`, executes all **252 JVM
tests with zero failures, errors or skips** and compiles both the application
and instrumentation APKs. Its 280 recorded Android source inputs are unchanged
through the run and include the corrected README, loading probe and final T45
implementation. The two added regression methods exercise all three sync-failure
boundaries, verify that private bytes wait for ownership durability, and preserve
an unowned replacement during failure cleanup. The earlier 250-case executions
remain preserved checkpoints; they are not added to the current test count.

The separate final host run, recorded in
`android-host-media-sync-final-20261030/result.json`, passes **69 cases with zero
failures** and **32 stable recorded inputs**. It executes actual ownership logic
against a temporary host filesystem with explicit real host directory fsync.
Its compile-only Android syscall stubs throw if invoked. This run does not
execute or qualify the production Android `Os` directory-sync implementation.
The earlier 31-input host checkpoint remains historical evidence and is not
presented as matching the later changed source.

The first API-24 compatibility run passed four checks and then exposed the
production `EISDIR` failure when opening the ownership directory with a desugared
`FileChannel`. That is the defect corrected by T45. An initial fix also failed
SDK compilation because it referenced a non-public directory flag; that failed
attempt is retained. The final source uses public APIs available since API 21:
read-only/no-follow/nonblocking open, `fstat`/`S_ISDIR` validation, `fsync` and
`close`. It does not use hidden directory flags, `O_CLOEXEC` or `fcntl`.

The final lint run, recorded in
`android-lint-media-sync-qualified-20261030/result.json`, passes with **zero
fatal issues, zero errors and 66 warnings**, with all 280 recorded Android inputs
stable. The earlier `android-lint-media-sync-final-20261030` attempt failed
before lint execution because the sandbox prevented Gradle's socket creation.
It is retained as a failed attempt that executed no lint analysis; its empty
issue list is not a zero-warning pass. The earlier 30 October 66-warning
checkpoint before T45 also remains historical. Reusing the previously unused
loading resource removed one unused-resource warning at that checkpoint; it did
not resolve unrelated lint advice.

**Final offline API-24 runtime verification passed all three instrumentation
invocations**, recorded in `emulator-journeys-final/result.json`. The installed
application and test APK bytes match the final build artifacts before and after
execution; recorded source and other input bindings remain unchanged. The final
run reports no failure, no cleanup errors and no unconfirmed fixture cleanup.

| Final invocation | Actual result | Scope |
|---|---|---|
| Compatibility with WRITE denied | Eight checks passed | Installed launcher/Activity, desugared protocol and journal behavior, AndroidKeyStore signing/encrypted atomic vault, private-file ownership and expiry, FileProvider bytes/grant, denied legacy MediaStore save, and a private local notification. |
| Compatibility with WRITE granted | Eight checks passed | The same installed compatibility checks, with the save branch confirming exact saved bytes through scoped OS-provider inspection. |
| Loading localization | Three stages passed: EN→RW→EN | Two exported ProgressBar nodes retain contextual labels, indeterminate semantics and stable bounds while their state changes `Loading`→`Birafunguka`→`Loading`. |

The compatibility runs execute the corrected production directory-sync default
and preserve create-new/no-follow behavior, timestamps, expiry and unknown or
symlink targets. Their eight-check inventories overlap and are reported per
permission branch rather than as sixteen distinct test cases. The runner
restores WRITE_EXTERNAL_STORAGE to its prior recorded state. **No independent
native READ_EXTERNAL_STORAGE permission check was executed**; the package-dump
permission observations are retained with that limitation.

The locale probe changes only its owned Compose configuration contexts, leaving
the global OS locale unchanged. These are offline assertions on one API-24
x86_64 software emulator. They do not establish hardware-backed keys, optical
capture, full camera/upload or document-provider flows, actual refresh HTTP or
face recovery, live backend/provider/store behavior, spoken TalkBack, physical
device behavior or performance acceptance. Actual browser and Apple SDK
qualification also remain external work.

An earlier emulator process disappeared between checkpoints. The separate
`emulator-boot-restarted-qualified/result.json` records restarting the same owned
AVD with retained data and verified disconnected socket backends before guest
CPU execution, followed by restoration of the offline policy. That runtime
re-establishment is not a controlled power-loss or application-recovery test.
After the final successful journeys, `emulator-cleanup/result.json` records the
exact owned emulator process and private ADB server stopped, with ports 5038,
5680, 5681, 5688 and 5689 closed. Cleanup did not reset or delete package data or
AVD files, or act on an unknown device or the default ADB server.

`VERIFICATION.md` and the current Android addendum retain raw failures,
permission observations, exact APK/source bindings and these software-emulation
limits. Earlier loading-only and compatibility attempts remain bound to their
own APKs; the first four-check failure and failed SDK/lint attempts are not
rewritten as successful executions.

The handoff keeps the full application route and the unchanged 90- and 209-file
baseline upgrades, and adds a separate upgrade from the delivered 221-file
Android-qualified package. Each incremental route retains the same original
HEAD and exact before-hash/prerequisite checks. Committed or edited prior
deliveries require a reviewed merge, not bypassing those guards.

## External acceptance work after applying the code

The six former local engineering items are implemented in this edition.
Remaining acceptance needs the actual platform, environment, account or evidence:

1. Compile the iOS application and XCTest target with macOS/Xcode and the Apple
   SDK, then execute the supplied Foundation and XCTest regressions.
2. Run camera, protected storage, restart/process-kill, permission, save/share,
   notification and store journeys on supported physical devices.
3. Install migrations 14–17 and the matching independent journal/API versions
   in an isolated staging environment, configure real budgets and services, and
   exercise the full restore runbook with external-effect uncertainty and holds.
4. Qualify APNs/FCM, Apple/Google purchase/refund/restore callbacks, model service
   deployment, representative recognition thresholds and peak capacity/cost.
5. Provision approved policy/support/deletion pages, independently controlled
   administrator access, operational owners/alerts and accepted rollout criteria.
6. Produce signed replacement binaries, verify real in-place upgrades, complete
   store declarations/review, and run the supplied CI lanes remotely.

No new dependency package was introduced. These source changes have not been
pushed, applied to a hosted database, deployed, signed or submitted to a store.
The verification report distinguishes executed local tests from supplied native
tests and externally dependent acceptance; skipped tests are never counted as
passing tests.
