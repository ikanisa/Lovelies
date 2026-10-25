# Lovelies replacement integration — 25 October 2026

The replacement is **not ready for runtime deployment or store submission**.
The owner has authorized completing that work. The remaining gates below are
technical and operating requirements, not a renewed request for authorization.

Supabase project `ltqfplqevxztlswlzexn` remains the backend target. Preserve the
existing `com.lovelies.memories` store identities and signing lineage. No real
Memories customers, photos or subscriptions require an import; preserve unknown
or test records and source history. The audience is 13+, with independently
reviewed guardian authorization for ages 13–17. There is no OTP or liveness/PAD.

## Implemented and checked within bounded snapshots

| Surface | Actual evidence | Scope and current limitation |
|---|---|---|
| Audience and guardian API | Age declaration, separate purpose approvals, independent fresh operator review, reviewed adulthood, current challenge authority, withdrawal and private cleanup implemented. Three independently found lineage/replay/cleanup P1s were fixed; 11 focused runtime tests passed and a second source review closed those fixes. | Additive v9/v10/v11 are local only: audience tables, immutable engine bindings and a private scan cursor, 68 total application tables. Fresh hosted catalog readback remains schema8/63 with forced RLS and zero client/public table ACLs. No hosted forward migration, adult backfill or import occurred. |
| Whole API regression run | `backend-aggregate-attempt8`: **291 tests, 290 passed, zero failed, one skipped**, with 85 unchanged inputs. Actual Deno entrypoint, PostgreSQL concurrency/non-superuser migration and current TypeScript/Deno checks pass. All six new inactive-profile cases also pass separately on PGlite. | The one skip is actual OpenFace HTTP; the current pinned-image/Edge/native integration is separate and in progress. Failed attempt7 retains two test-clock failures; corrected assertions use the persisted retirement clock and a genuinely future timestamp. The negative writer-clock counterexample is preserved and its production guard is included in the passing final run. |
| Android | Full non-incremental JVM suite: **192 passed, zero failures/errors/skips**, including14 cache cases, with84 unchanged inputs. Current main and connected-test APKs also compiled with100 unchanged inputs. | Session/monotonic expiry and recognized temporary-file cleanup preserve durable uploads, protected capture drafts and user-saved media. Connected journey fixtures are being amended through the public adult declaration; the earlier compile does not qualify those later fixture edits or physical/store behavior. |
| iOS hosts | Original ten controlled suites: **1,020 checks passed**; **35 separate private-media checks passed** on the current repository graph. New creation/session-bound cache expiry, exact-asset denial and recognized temporary-file cleanup are covered. | Host proof does not establish SwiftUI, physical camera/Keychain, background OS behavior or hosted/store acceptance. Durable uploads, unknown files and deliberate Photos/Files copies are preserved. |
| iOS physical repository | One actual iPhone12Pro/iOS26.7.2 app-hosted XCTest passed, zero failures/skips. It exercises true test-scoped Keychain and SecureEnclaveP256, three signed declared JPEG enrollment into the same anonymous account, logout/retained key/profile, fresh one-still return login, consumed-challenge replay denial and owned-key/session cleanup assertions. | Exact test source `9be59986…f4b9`, existing development signing lineage and actual isolated Edge1.77.8/PostgreSQL11/privateStorage/pinned inference. No optical camera, representative accuracy, Apple authentication-policy or store-installed upgrade acceptance. Phone disconnected after the test; exact post-test existing app-data equality remains pending, with pre-test data preserved. |
| Android16KB runtime | [Exact8af Debug APK selected ARM64 graphics/DataStore operations and memory protection pass on an actual16KB API36 emulator](android-16k-readback-20261025.md), compatibility mode disabled. | Preserves GNU_RELRO-end formula flags and earlier harness receipts. Final signed AAB/generated APK set, other ABIs, whole app runtime and Play validation remain open. No dependency change was made. |
| iOS app and reference UI | New grouped app/runner/unsignedRelease build passes205 unchanged inputs. Exact `66380fcd…4be2`/c8r5 was installed with qualified data-container reconciliation; smoke and normal40–42 pass. Largest40/42 pass; largest41 retains two unwaived native contrast flags on off-viewport text. Largest19–24 navigation/custom checks pass;19/20 retain three native contrast flags and23 retains two anonymous native clipping flags pending diagnosis. | Actual80 manual native-switch activation/padding probes restore all10 values; precise edge and actualrw-language QA are prepared in additivec9. Current6638 largest25–36 checks remain. Approved Settings accessibility-label reflow `08840043…5f02` requires its own rebuilt artifact/runtime. Earlier a714/c7r2 failures and keyboard passes keep their original scope. |
| Inactive-profile metadata | After14days from original retirement, old reference addresses/digests are minimized only after verified cleanup, fresh absent HEAD and exact post-await metadata checks. Bounded source-class rotation, holds, pending challenges, current references, uncertain/newer/inconsistent writers and transaction rollback are covered by six current cases. | Minimal exact completion facts preserve signed status and fresh three-capture re-enrollment without granting credentials or retaining the old address. This is local enforcement; backup production/catalog, independent suppression/replay and startup restore quarantine remain unimplemented and unqualified. |
| Operator workspace | Strict audience/challenge and minimized guardian/adulthood review controls implemented. **All 94 controlled operator tests passed again against the final inactive-profile source**, including service worker and backend integration. Three reviewed fixes preserve durable uncertain-action replay, clear private state on product denial, and recheck capture authority after awaits. | Saved key/body/account remains exact through reauthentication and withdrawal. Actual browser camera, hosted roles and independently operated guardian review remain unqualified. The earlier55 pure checks remain a separate snapshot. |
| Additive database migration | Real PostgreSQL/PGlite v11 composite cursor checks passed 4/4. The exact staged v9–v11 transaction passed with a seeded unknown/test account and policy/hold preservation. Adult receipt continuation handles more than 20 recent reviews, invalidates backdated generation changes and fails closed on malformed checkpoints. | Five empty private tables, two nullable generation columns; no imports, backfills, deletion or new role membership. Current hosted readback on 25 October is still8/63/forced RLS/zero client-public table ACLs. The exact transaction is staged, pending the browser-policy action-time grant confirmation. |
| Public policy package | Five updated HTML pages and 95 local links checked. The 13-file allow-list was uploaded as an isolated preview. Dashboard inventory and actual browser rendering confirm immutable deployment `62953714-2a67-4c49-80dd-75d12ecf0376`. | [Privacy preview](https://62953714.lovelies-web.pages.dev/privacy/) is a review draft, not an effective policy. The generated branch alias initially returned Deployment Not Found. Terminal readback returned Cloudflare1010/403, so current byte/header qualification remains open. Production and shared admin/photo hosts were preserved. |

The original backend/operator source is committed as `b8bb1879596a8ac5bf6d4529f24927bcbb37c810`.
The final native audience/cache/unit and inactive-profile API source is committed
as `bdeb7b4dafdee99f3c1d60972efb6d65fad2f3e3` (33files). Private inference/build
source is separately committed as `0ebb8bb82f188e91a5b91e0759ec39229855e0cf`;
its image remains unaccepted for production. Active UI, connected/device fixtures
and public-web work are outside these bounded commits.
The private [ikanisa/Lovelies repository](https://github.com/ikanisa/Lovelies) and
local origin were created and verified on 25 October; Memories is preserved.
The coordinated source and release-doc checkpoint was pushed/read back on `main`
as `768e3adf8b67f17562fc7d8c1e17a900580a3c2d`. The bounded source commit excludes
active ML, native-client, UI and public-web work. Both the initial push and one
controlled dispatch failed in GitHub startup before any job. The exact workflow
passes verified actionlint1.7.12. Authenticated GitHub readback identifies the
existing organization billing hold. The owner has explicitly parked GitHub
billing; no payment, limit change or CI retry is requested. Current source delivery
uses the documented skip-CI annotation while that hold is parked; no passing
remote CI is implied. Private source push/readback now confirms bdeb7b4, including the separate ML source commit. The source seal and delivery receipt retain their exact scope; current UI/connected work is still outside that delivery.
CI/delivery receipts remain separate from local tests and hosted/store acceptance.
The later seven-document checkpoint is pushed/read back at
`f94d464d56d55806da176e85b83530df824f63fb`. The current physical/runtime/UI
receipts and remaining active source are reconciled separately; that prior
checkpoint does not silently include subsequent edits.

The selected numerical periods and guardian controls are in
[retention-and-young-users.md](retention-and-young-users.md); their protocol is
[audience-api-contract.md](audience-api-contract.md). Selection is not proof of
provider retention, backup expiry, monitored cleanup or trained review operation.

## Required before replacing the live app

1. Preserve the passing bounded retention/maintenance implementation and complete
   actual retention operation, including the remaining backup/restore, minimized
   receipt lifecycle and independently operated backup/restore requirements. Native
   cache and bounded inactive-reference minimization now pass locally. Qualify the exact
   native inference image, security scan and representative evaluations. The
   controlled whole API and actual PostgreSQL/Deno checks pass.
2. Complete the grouped reference accessibility fixes and qualify their rebuilt
   consumers, then qualify actual connected age/guardian/picker/camera/privacy
   flows. Strong collection implementation,1,020 original plus35 cache host checks
   and192 JVM tests pass. Reference-screen tests do not cover the connected audience UI.
3. Reconcile supported Supabase migration history, qualify/apply the reviewed
   additive migration sequence, deploy API/private inference and configure
   server-only workload credentials, schedules, alarms and failure recovery.
4. Demonstrate actual retention, object absence, backup expiry and restore
   suppression. Qualify independent guardian/privacy/support operators and the
   mailbox/ownership/status workflow before making the public promises effective.
5. Publish qualified notices/support/deletion/association routes while preserving
   the existing admin/photo domains. Set the real native policy and link inputs.
   Current iOS artifact preflight still reports exactly six gates: link host,
   four public URLs and a valid distribution signature.
6. Qualify APNs/FCM and store verification/notification callbacks, reviewer
   enrollment/sharing/purchase access, accurate privacy/data-safety/audience/rating
   declarations, genuine assets and passing remote CI/final whole-app source sealing. The bounded
   earlier backend source is delivered; both CI runs stop before jobs due to the
   billing hold the owner has parked. Preserve that unresolved remote-CI gate.
   Resolve Apple2.5.13
   account-authentication architecture: current iOS code does not use
   LocalAuthentication; age13+ alone does not resolve that store requirement.
7. Refresh all-track store build maxima; build and inspect signed AAB/archive,
   qualify in-place updates over store installations without reset/uninstall,
   perform testing/review submission and verify both live updates. Retire the
   donor repository only after stable replacement and the observation period.

The Apple v127 agreement, existing-ID capabilities/profile and saved store-copy
drafts retain their own verified records. They do not establish a submitted or
published release. Prior source-bound device/provider/model results remain
historical when their inputs differ; counts above must not be added together.

## Retained execution evidence

All paths below are under
`verification/supabase-release-20261023/audience-implementation/`:

- `p1-remediation/handoff.json`: focused API fixes and hashes.
- `backend-aggregate-attempt2/` and `backend-aggregate-attempt3/`: original and later failed full regressions.
- `final-affected-attempt1/`: typecheck pass and36/39 affected runtime snapshot.
- `operator-p2-pure-attempt1/`:55 pure current operator/session checks.
- `postgres-migration-v11-attempt2/` and `staged-v9-v11-composite/`: current real PostgreSQL/PGlite composite schema and exact transaction preservation proof; prior editions remain preserved.
- `backend-aggregate-attempt4/`: preserved283/285 failure snapshot; `attempt5/` records Docker preflight only, no tests.
- `backend-aggregate-attempt6/`: prior284/285 pass, one actual-inference skip,84 unchanged inputs.
- `backend-aggregate-attempt7/`: preserved288-pass/two-clock-fixture-failure/one-skip snapshot.
- `inactive-profile-focused-attempt2/`: corrected six-case proof on both engines before the final inconsistent-writer guard; retained within that source scope.
- `inactive-profile-writer-clock-counterexample/`: actual pre-fix negative case; no cleanup completion credit.
- `backend-aggregate-attempt8/`: final290/291 pass, one actual-inference skip,85 unchanged inputs; TypeScript, Deno and six affected PGlite cases also pass.
- `backend-deno-check-20261025/`: current cached Deno import-graph check.
- `operator-aggregate-20261025/`: earlier94-pass controlled operator suite; `operator-aggregate-current-20261025/` repeats all94 successfully against the final inactive-profile source.
- `github-canonical-20261025/`: private repository identity, bounded source seal and delivery/CI readback.
- `hosted-readback-20261025/`: current schema8/63/forcedRLS/no-client-ACL browser readback; prior24 October evidence remains preserved.
- `android-unit-attempt1/` historical171-pass; `android-unit-attempt2/` preserved incremental ABI failure; `android-unit-attempt3/` full178-pass recompilation.
- `android-cache-unit-attempt1/`: current192-pass non-incremental compile/JVM result.
- `android-instrumentation-compile-attempt1/`: APK/test-APK compilation only, before later public-age fixture amendments.
- `ios-collection-host-attempt1/result.json`: ten suites and1,020 current host checks.
- `ios-cache-host-regression-attempt1/`, `ios-private-media-attempt1/`: current ten-suite1,020-check repeat and separate35-check cache result.
- `ios-grouped-cache-build-20261025/`: a714 app/c7r2 runner compile, exact products and runtime handoff; later UI proposals are outside that artifact.
- `current-source-seal-20261025/source-seal.json`: exact33-file source commit and its separate proof bindings.
- `ios-build-attempt3/`: strong collection/callback fix artifact595.
- `ios-build-attempt4/{result.json,artifacts-readback.json,preflight.log}`:
  two reference text-size fixes, immutable180-file QA artifacte32 and six remaining artifact gates. Prior builds are retained.
- `operator-focused/`, `operator-integration-attempt1/`: bounded workspace proof,
  preserved failed attempt and corrected exact account/key/body regression.

Public preview staging/deployment/rendering and failed readbacks are retained in
`verification/supabase-release-20261023/store-draft-20261024/public-site-preview-v2/`.
