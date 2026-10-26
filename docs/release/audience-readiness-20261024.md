# Lovelies replacement integration — 26 October 2026

The replacement is **not ready for runtime deployment or store submission**.
The owner has authorized completing that work. The remaining gates below are
technical and operating requirements, not a renewed request for authorization.

Supabase project `ltqfplqevxztlswlzexn` remains the backend target. Preserve the
existing `com.lovelies.memories` store identities and signing lineage. No real
Memories customers, photos or subscriptions require an import; preserve unknown
or test records and source history. The audience is 13+, with independently
reviewed guardian authorization for ages 13–17. There is no OTP or liveness/PAD.

## Current26October execution delta

This section supersedes conflicting25October descriptions below within its exact
source/environment scopes. Hosted v9–v11 and v12 are applied: schema12/69 private
forced-RLS tables/backend policies, zero client/public access/backend membership.
The v12 transaction preserves all67 old non-version table fingerprints and adds
only empty restore_control; only expected schema-version rows changed. All6
supported history versions match; CLI Security Advisor reports no issues. No
import/deletion/backfill or runtime marker bootstrap occurred. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/hosted-v12-20261026/result.json`.

Current API:408 tests/407 pass/zero fail/one optional actual-model skip; current
types and41 focused collector/sharing/PG checkpoint/race checks pass. All94
operator tests also pass on the same frozen API source. Actual PostgreSQL17.11
and verified-local-TLS Deno entrypoint are included. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/restore-privacy-face-20261026/whole-api-05/result.json`.
The earlier344- and329-case passes and preserved failures retain their scopes. Stable deletion-request IDs/requested facts and HTTP/queue invocation lineage fencing are now integrated. Eight dedicated actualPG lineage cases pass after fixing test teardown order; the timed-out cleanup-failure run and type-only maintenance inference correction remain preserved.

The journal protocol's34 local SQLiteDO checks remain valid. The API now collects
immutable exact sharing-request retirement facts before decline/withdraw/revoke
SQL changes, with stable actor/source/key operation IDs and separately bound
payload hashes. Receipt retries and already-terminal transitions create no
duplicate restriction. Lost prepare/commit/ack, restored accepted rows, nested/
read-only/closed scopes, invalid registration and manifest bounds are covered.
Stable deletion-request allocations and exact requested-stage facts also precede SQL effects; receipt/altered-input/lost-result cases pass. HTTP/queue/maintenance invocations bind their first verified database incarnation, reject stale/poisoned/escaped continuations and perform final admission before response release. Independent review closed a mutable-admission alias issue. Exact signed pause/resume/authentication-withdrawal/removal facts now pass. Independent delete review and stable final-erasure facts preserve minimal asset/hold evidence until fresh lease/hold/metadata/no-writer/verified-cleanup checks pass; a stale DELETE completion cannot downgrade a successor result. Initial focused and temporal test failures remain preserved alongside corrected final proof. Other non-action/indirect producers, durable capacity above32, stable resource allocations, external-effect generation fences, replay/object inventory/cleanup, computed completion and hosted journal custody remain open. Operated post-tombstone asset holds and request-hold ABA generation remain unqualified.
No recovery-clear endpoint or manual flag exists.

Inference d815 preserves the qualified982e runtime payload/config. Provider
image-health and exact loaded readiness are qualified within their receipts.
A separate seven-case run now passes using the actual deployed model through
an authenticated private account ServiceBinding, actual PostgreSQL and production
API HTTP handler. It covers signed same-account enrollment/login, wrong-face/
replay denial, exact sharing, and held-result profile/consent/session/source/
lease fences. The refreshed run-04 seals100 source inputs and19 declared engineering JPEGs. All actual model-consumer inputs remain unchanged; a later terminal-test assertion change is outside its executed/imported suite. Storage is controlled in-memory; cleanup assertions in this run do not
qualify Supabase Storage DELETE or provider custody. This is not representative
recognition quality, physical capture or hosted application acceptance.
The first local gateway attempt stopped before the suite because nested JSON
was escaped by dotenv; the causal typed-config fix and original failure remain
preserved. The successful run removed task-local credentials and preserved the
source credential files. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/inference-packaging-20261026/private-inference-qualification/run-04/result.json`.
The earlier root-client HTTPS403/1010 was not retried or disguised. Actual Supabase Edge→configured inference HTTPS readiness now returns200 with exact identity and401 unauthorized control. Its temporary diagnostic was removed; shared secrets and other functions were preserved. This is readiness transport only; hosted image/Storage consumers and API cutover remain unqualified. Receipt: `/Volumes/PRO-G40/Projects/Lovelies/verification/supabase-inference-egress-20261026/result.json`.

Current iOS: original1020 host checks, separate101 guest-deletion/35 private-media
checks and108 focused LocalAuthentication fixtures pass. Canonical21-source
Simulator Debug and unsigned iOS Release builds pass; the complete XCTest target
also builds with the updated physical opt-in signer/real OS-authorizer adapter.
No test/device prompt was launched by those builds. Source-bound proof is under
`/Volumes/PRO-G40/Projects/Lovelies/verification/native-local-auth-20261026/`.
The exact Release bundle still has six preflight gates: published link host,
privacy/terms/support/deletion URLs and distribution signature. Physical
FaceID/TouchID/passcode, new/legacy key ACL, lifecycle and App Review remain open.

The selected push gateway now requires an independent Cloudflare SQLite ledger
before reading provider keys or listening, with no application-PostgreSQL
fallback. All46 provider/transport/Worker/Node integration tests, expanded syntax
checks and Worker dry run pass on unchanged inputs. Partial SQL/KV rollback,
dispatch-intent loss, stale claims, lost responses, quarantine and saved receipts
are covered. Actual host/EU binding/custody/provider credentials/device delivery
remain open. Evidence: `/Volumes/PRO-G40/Projects/Lovelies/verification/push-independent-ledger-20261026/root-integration/result.json`.

Fresh schema12 encrypted-backup qualification passes11 actual nativePG17.11
checks with53 unchanged inputs after the collector integration. All69 table hashes and the opaque control row
reconstruct; seven-day expiry and old-marker quarantine pass. The original
Result-array assertion failure is retained. Independent hosted custody/media
replay/scheduling and serving recovery remain open. Evidence:
`/Volumes/PRO-G40/Projects/Lovelies/verification/encrypted-backup-schema12-20261026/attempt-04/result.json`.

Isolated Edge driver
source now includes schema12, required TLS journal/CA and bounded relays; its
syntax passes, while actual Docker/Edge execution remains unqualified because
the daemon was unavailable. The [full goal](full-implementation-goal-20261026.md)
reconciles all90 IDs into33 packages. GitHub billing remains parked; independent
CI and both live/stable store replacements remain open.

## Implemented and checked within bounded snapshots

| Surface | Actual evidence | Scope and current limitation |
|---|---|---|
| Audience and guardian API | Age declaration, separate purpose approvals, independent fresh operator review, reviewed adulthood, current challenge authority, withdrawal and private cleanup implemented. Three independently found lineage/replay/cleanup P1s were fixed; 11 focused runtime tests passed and a second source review closed those fixes. | Additive v9/v10/v11 are local only: audience tables, immutable engine bindings and a private scan cursor, 68 total application tables. Fresh hosted catalog readback remains schema8/63 with forced RLS and zero client/public table ACLs. No hosted forward migration, adult backfill or import occurred. |
| Hosted Supabase configuration | OfficialCLI2.84.2 now accesses/links the selected project. Fresh SQL confirms8/63 forced-RLS tables, zero client/public ACLs/backend membership, zero appaccounts and the three private20MiB buckets. Exactly3initial signing/maintenance secrets are applied and their server digests match. Supported CLI history repair records only already-applied v7/v8; exact source hashes and all63 table-row fingerprints match before/after. Security advisor after repair reports zero items. | Application functions remain zero. No Supabase reconnection is needed; browser controls remain disabled for store consoles/review. The existing v9–v11 named-grant confirmation remains pending, with a usable CLI path. Serving model/API/provider/backup/restore operation is still unqualified. |
| Whole API regression run | Current schema request gate: **296 tests,295 passed,zero failed,one optional actual-model skip**,87 unchanged inputs, actual PostgreSQL/Deno and TypeScript pass. Existing and new requests stop on older/newer/empty recorded history without changing any of68 private tables. | [Gate, counterexamples and restore limits](schema-request-gate-20261025.md). Prior293/292-pass receipt and291/290-pass attempt8 retain their source scopes. No hosted deployment or automatic model/device requalification follows. |
| Android | The later99ed Debug availability-copy build and **197 JVM tests pass** with257 unchanged inputs; eight JNI payloads match6603 and fresh ZIP alignment/Debug signature checks pass. The earlier6603 app passes all18 affected grid cases across nine screens at1×/2× text, with all29 original PNGs inspected, and12 anonymous-deletion HTTP checks against the actual Supabase handler/embedded PostgreSQL. | [Exact grid/runtime scope](android-source-grids-20261025.md) and [new copy/build scope](schema-request-gate-20261025.md). The99ed package has no new runtime acceptance. Earlier five connected journeys keep their8af runtime/pool scope. Spoken/physical behavior, final signed artifacts and store-installed updates remain open. |
| Android connected audience | The same6603 Debug app passes five actual native UI/repository/Keystore checks: select13–17, retain anonymous authority, create a pending guardian request, confirm withdrawal and reach guest privacy/deletion. A separate fixture-archive readback confirms one gated teen/withdrawn request and zero approvals, consents, grants, profiles or active sessions.343 inputs remain unchanged. | [Exact connected scope and preservation](android-connected-audience-20261025.md). No registered guardian, independent human review/approval, camera/media/provider, hosted, physical, spoken or store acceptance. One confirmation image is a fade-transition capture, not settled contrast proof. |
| iOS hosts | All **1,020 original host checks** pass again against the staged availability-copy branch and are adopted by exact16-input canonical equality. The earlier **35 private-media** and **101 guest-deletion** receipts retain their parser/source scopes. Actual producer replies reproduce the old receipt failure and qualify bounded final deadlines/retained overdue status. | Separate controlled scopes, not one unique-test total. Host proof does not establish SwiftUI, physical camera, Keychain, hosted operation or signed/store acceptance. |
| Swift audience HTTP | [Six cases/26 assertions](ios-connected-audience-20261025.md) pass against the actual production API/PostgreSQL17 through production URLSession/repository,49 unchanged inputs. Under13 denial, pending teen request/withdrawal,503 credential/journal preservation and original-key retry keep exact anonymous accounts; final SQL readback has zero active sessions, purpose receipts, media grants, profiles, devices or challenges. | Host memory storage and a signer that refuses enrollment. Actor reconstruction is not process death; no UI/physical/Keychain/independent guardian approval/provider/hosted or store acceptance. |
| iOS physical repository | One actual iPhone12Pro/iOS26.7.2 app-hosted XCTest passes, zero failures/skips: true scoped Keychain/SecureEnclaveP256, three signed declared JPEG enrollment, same-account return login, replay denial and owned cleanup. Post-test preservation is resolved: original9-file and complete10-file copies retained, encrypted profile/four common paths byte-identical; StoreKit timestamp and OSscene/snapshot changes accounted. | This retains the exact pre-correction API85/native/runtime scope in [the connected checkpoint](../openface-integration-continuation.md). No optical camera, representative recognition, default Keychain inventory, Apple authentication-policy or store-installed upgrade acceptance. |
| Android16KB runtime | [Exact8af Debug APK selected ARM64 graphics/DataStore operations and memory protection pass on an actual16KB API36 emulator](android-16k-readback-20261025.md), compatibility mode disabled. | Preserves GNU_RELRO-end formula flags and earlier harness receipts. Final signed AAB/generated APK set, other ABIs, whole app runtime and Play validation remain open. No dependency change was made. |
| iOS app and reference UI | Round8 app/base revision7runner/unsignedRelease compile passes205 unchanged inputs. Focused normal/largest filtered-photo named actions/return state pass. A separate revision8 runner-only test passes one maximum filtered-search coordinate-touch case on first execution:8drags reveal a full44pt-or-larger hittable Photo2; tap opens12 and Back15 preserves all4Selected. All5 originals are reviewed. Current one-install preservation retains7payloads135,123B/22common nodes; the OSsnapshot rename and earlier saved-state transition are reconciled. | [Current scoped checkpoint](ios-reference-ui-20261025.md). No full48 matrix/native audit was replayed; old adverse rows remain unwaived. Absent-layout, spoken, physical-device/provider and store acceptance remain separate. All six link/public-URL/distribution-signature preflight gates remain. |
| Inactive-profile metadata | After14days from original retirement, old reference addresses/digests are minimized only after verified cleanup, fresh absent HEAD and exact post-await metadata checks. Bounded source-class rotation, holds, pending challenges, current references, uncertain/newer/inconsistent writers and transaction rollback are covered by six current cases. | Minimal exact completion facts preserve signed status and fresh three-capture re-enrollment without granting credentials or retaining the old address. This is local enforcement. [Encrypted database backup/catalog tooling](database-backups.md) now passes15 operator checks and nine actual68-table PostgreSQL reconstruction checks after fixing post-verification mutation delivery; hosted custody/scheduling, independent suppression/replay and startup restore quarantine remain open. |
| Operator workspace | Strict audience/challenge and minimized guardian/adulthood review controls implemented. **All 94 controlled operator tests passed again against the final inactive-profile source**, including service worker and backend integration. Three reviewed fixes preserve durable uncertain-action replay, clear private state on product denial, and recheck capture authority after awaits. | Saved key/body/account remains exact through reauthentication and withdrawal. Actual browser camera, hosted roles and independently operated guardian review remain unqualified. The earlier55 pure checks remain a separate snapshot. |
| Additive database migration | Real PostgreSQL/PGlite v11 composite cursor checks passed 4/4. The exact staged v9–v11 transaction passed with a seeded unknown/test account and policy/hold preservation. Adult receipt continuation handles more than 20 recent reviews, invalidates backdated generation changes and fails closed on malformed checkpoints. | Five empty private tables, two nullable generation columns; no imports, backfills, deletion or new role membership. Current hosted readback on 25 October is still8/63/forced RLS/zero client-public table ACLs. The exact transaction is staged, pending the existing named backend-grant confirmation; the official CLI is now usable. |
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
The later20-file connected harness/fixture checkpoint is pushed/read back at
`96fc61b4ccfc510b222344539c05d9326a1a33e6`. Current receipt-contract code
and its local verification are a separate later source scope; four active UI
files and runtime QA remain under their explicit build freezes.
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
   flows. The corrected source passes 1,020 original Swift host checks, 101 guest
   deletion checks, 35 cache checks and 197 JVM tests in their separate scopes.
   Reference-screen tests do not cover the connected audience UI.
3. The supported baseline7/8history is reconciled with application rows preserved.
   Resolve the pending9–11 grant condition, qualify/apply the reviewed additive
   sequence, deploy API/private inference and configure
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
