# Disposition of the 90 readiness work packages

Reconciled on **23 October 2026** against the current implementation and receipts.
This supplements the preserved [original register](../remaining-submission-tasks.md);
it does not rewrite its historical observations or turn local implementation into
deployment, signing, provider, device, professional or store acceptance.

**The replacement is not yet ready to deploy its runtime or submit.** Supabase project
`ltqfplqevxztlswlzexn` is selected. Following explicit owner approval, the exact
v7+v8 transaction succeeded. Hosted readback confirms schema 8,63 tables with forced
RLS,63 backend-only policies, zero accounts and no client-role schema access or
backend membership. Three private buckets and exact size/MIME restrictions are provisioned/read back. API/supporting-service deployment and complete configuration/backup acceptance remain. The two pre-existing function-execution warnings have targeted grant correction/readback; post-change security linter reports zero items. Both existing store
records/upload histories and local signing continuity are observed; production
artifacts and installed update acceptance remain separate gates.

The owner confirms **no real Memories users, photos or subscriptions need
migration**. Legacy customer imports/handoffs in R03–R07 therefore do not apply.
Existing store identities, product/restore contracts, installed test-state
preservation, signed update qualification, rollback and source history still apply.
No unknown or test data may be deleted on that premise.

## Evidence boundaries used below

- **Backend:** [Supabase architecture](../supabase-backend.md) and current receipts
  under `verification/supabase-release-20261023/`. The asynchronous PostgreSQL/
  private Storage/jobs port exists; unchanged v7 plus additive v8 = **63 tables**.
  **209 distinct current cases are covered**:175 unchanged cases from the retained
  full attempt plus all 34 cases in the corrected affected account-recovery file.
  The full attempt had205 passes/four failures from its explicit secret-scan table
  allowlist omitting the new encrypted receipt table. Only that test allowlist
  changed; the entire affected file passed 34/34. This is not one green209-case
  aggregate run. `backend-integrated-reconciled-final.json` binds the results;
  typecheck and actual Deno check pass. The affected strict-role/concurrency v8
  run separately passed 49/49 actual-PG cases; do not add overlapping counts.
- **Native:** [Android checkpoint](../android-release-progress.md),
  [iOS checkpoint](../ios-release-progress.md) and root receipts. Latest combined
  checkpoint passed Android **156 tests/14 suites**, app/test APK packaging and
  unsigned iOS **Release/Debug build-for-testing** with unchanged inputs. **665
  Swift host checks passed**. Physical Pixel normal-font48/48 and enlarged-font
  no-scroll48/48 passed on their bound checkpoints. The UI owner corrected clipped labels, adaptive people names, profile-header sizing, compact landscape onboarding and the schema3 scroll audit and complete Profile-statistic labels; the latest156-test combined build includes the frozen repair. Final physical normal/enlarged/landscape/scroll/keyboard retakes are in progress.
  Failed font-hook/landscape/scanner runs are preserved. Reference fixtures do not
  establish connected service, iOS runtime or spoken screen-reader acceptance. Current schema3 normal48/48 and font2 48/48 passes are bound to V3 immutable APKs; landscape45/48 retains three failures under test-only scroll diagnosis,46/46 applicable Back checks pass, all257 screenshots are reviewed, and fresh V3 font2 keyboard routes15/22/45 pass. Root also compiled the final two-file schema4/visible-exit test-only batch with unchanged inputs and the byte-identical V3 product APK; Gradle reused the unchanged156/14-suite unit results. V4 targeted20/39 pass,14 retains Save photo5; all three visible exits pass. V4 normal/font2 visible navigation each completed48 cases with only the incorrect Cancel7 expectation failed; raw outcomes remain. Final V4.2 Cancel7 passes normal/font2 but Favorites14 still fails. The V5 one-file reference14 viewport correction passes a fresh156-test/14-suite combined build with unchanged frozen inputs and a new app APK; fresh14 normal/font2/landscape all pass, including fully observed48dp Save photo5 and actual visible Back, with no reset. Full48 V5 matrices/visual review are underway. MainActivity/tests are unchanged, broader shared-host candidate unbuilt, connected Favorites constraints unqualified. Physical iOS test01 passes initial reference lifecycle/custom-link isolation; its retained failed navigation attempt is blocked by an unrelated floating video overlay, awaiting owner removal before same-source retry.
- **Private model service:** `logs/ml-private-final-3.log` records **23 passed**,
  including seven external-service authentication cases. These are local model/
  service-boundary checks, not representative threshold, faithful x86-container,
  physical-camera or hosted qualification.
- **Operator:** the live `admin/entry.mjs`, `live-app.mjs` and
  `operator-session.mjs` replace the default synthetic workspace with actual
  signed face/operator authority and API requests. Six routes, revision-bound
  reviews, exact pending-action retry and session revocation are implemented.
  The integrated local operator run passed **107/107 tests**, including lost
  refresh delivery and cancellation before first dispatch. Synthetic verifier/
  Storage fixtures and signed cryptography do not establish real browser camera,
  hosted provisioning or operated review acceptance. The independent reviewer closes all ten local recovery/race probes. Native combined builds pass within the checkpoint above; hosted/browser/device acceptance remains open.
- **Push:** [private provider gateway](../push-provider.md) now implements APNs
  HTTP/2, FCM HTTP v1 and durable receipt reconciliation. **19/19 local tests and
  six syntax checks passed**; credentials, host deployment and actual provider/
  device delivery remain unverified.
- **Release/public material:** [store observations](../store-update-identity.md),
  [public site](public-site.md), [policy draft](policy-content-draft.md),
  [store-copy draft](store-listing-en-US.md), [privacy/data worksheet](store-data-disclosures.md),
  [association-file package](website-associations/README.md), and
  [cutover/rollback plan](cutover-and-rollback.md). The five public pages and
  association files are prepared local drafts and remain unpublished. Canonical source is sealed locally in Git; the intended remote is unconfigured and prepared CI has not run on GitHub.

“Completed implementation; verification/configuration pending” means code exists
for the retained journey and the stated gate remains. “Verification/configuration
pending” also identifies any remaining implementation explicitly in that row.
No completion percentage is assigned to these differently sized packages.

## Existing-app replacement

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| R01 | Completed existing-record readback: both consoles observed; all ten Play uploads have maximum code 16, and eight Apple uploads have maximum build 14. | Refresh upload histories and release permissions immediately before upload; retain the existing app records and the store-identity receipts. |
| R02 | Completed identity/version implementation and local continuity readback. Both use `com.lovelies.memories`; Android `2.0.0`/18 and iOS `1.1.0`/18 were unused at inspection. Matching Play upload key/certificate and Apple team/profile were verified. | Keep the explicit Play highest-code/certificate release gates current; complete production Apple capabilities/profile and inspect package/bundle, signing, versions and Supabase URL inside the exact signed candidates. |
| R03 | Not applicable for legacy real-customer inventory/import on the owner's no-real-data premise. | Configuration/domain/provider and unknown/test-data inspection still belongs to SP01/R01/R09. Preserve unknown/test data; do not infer deletion authority. |
| R04 | Not applicable for a legacy customer-account handoff/import. | Preserve the new same-account anonymous-to-face upgrade and recovery tests under SP04/A01–A06; qualify synthetic installed-state behavior under R10. |
| R05 | Not applicable for legacy customer/media migration. | Reconcile actual project state before the additive Supabase migration; backup/restore, schema deployment and unknown/test-data protection remain SP01/SP03/R11. |
| R06 | Legacy subscriber import not applicable; existing product identity and future ownership/restore contracts remain applicable. | Both product readbacks are complete; Apple approved monthly product is available41/175 regions and Google active base plan175. Qualify intended territory coverage, configure credentials/callbacks and qualify new native purchase/restore, renewal/refund/revocation under P01/P02. |
| R07 | Not applicable for Flutter customer-state import. | Do not clear unknown installed test data or old key namespaces to obtain an update pass. R10 must establish signed upgrade behavior and recovery without a fabricated legacy import. |
| R08 | Verification/configuration pending. Current Play minimum API 24 was observed; native minimum is API 26. iOS supports the configured iPhone/iPad layouts with minimum 17. | Compare the actual candidate store-device catalog/coverage, current Apple coverage and supported-client TLS. Decide any supported-device compatibility change before rollout. |
| R09 | Coexistence plan prepared; existing Apple production/sandbox subscription callback destination observed. | Qualify the old callback/API/link dependencies, route compatibility and upgrade window; switch to one verified Supabase writer and correct outdated on-device-only/phone-code/Featured Photos store claims through the reviewed update. |
| R10 | Verification pending; no real-customer migration rehearsal is required. | Install the exact signed candidate over the current store-installed app without uninstall/reset. Exercise controlled anonymous/registered/purchase fixtures, offline upgrade, retained state/recovery and clean installs on both platforms. |
| R11 | Cutover/rollback plan prepared; operational configuration/verification pending. | Name owners/stop criteria/observation window; rehearse backup/restore and compatible forward recovery against the chosen hosted stack and signed artifacts. Preserve consent/revocation/erasure authority. |
| R12 | Source/release history preserved; canonical source sealed in local Git, without a remote. | Configure the intended remote and publish the sealed source/CI history; retire Memories release jobs only after both replacements are live/stable and the observation window passes. Review service/secret retirement separately. |

## Supabase authority and integration

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| SP01 | Pre-migration inventory preserved; owner-approved v7+v8 applied and schema 8/63 forced-RLS tables/backend-only policies read back. Private buckets/restrictions are provisioned/read back; function-execution grants corrected, post-change linter reports zero items. | Complete API/Auth/settings and backup inventory, retain clean advisor evidence and reconcile supported CLI migration history, and preserve unknown/test data. No runtime deployment is established by schema readback. |
| SP02 | Completed implementation: owner amendments and asynchronous PostgreSQL, private Storage, custom face-session, jobs and separate private-inference architecture recorded. | Keep deployment documentation aligned with the actual selected inference host/operator and provider settings; their configuration/readback remains B05/SP10. |
| SP03 | Completed schema-v8 port and approved hosted migration/readback.209 distinct current actual-PG cases covered across retained full/affected rerun;49/49 affected cases overlap. | Preserve reconciled current-source receipts, repair/read back CLI migration history through supported tooling, and qualify hosted API revision/idempotency/concurrency and backup/recovery. |
| SP04 | Completed anonymous-first face sessions and versioned durable refresh delivery/cancellation across backend, operator and native consumers. | Combined native/full current-source checks are recorded above; configure independent secrets and policy/model versions, then qualify hosted same-account enrollment, fresh login/recovery, expired/lost delivery, logout cancellation and consent/device/session revocation. |
| SP05 | Completed private-schema/forced-RLS/non-bypass-role implementation, local proof and approved hosted63-table/role readback. | Role/grant approval and schema-policy readback are complete; qualify actual API exposure and exercise guest/unverified/registered/revoked/cross-account/admin denial on actual project APIs. Keep privileged keys server-only. |
| SP06 | Completed private Storage adapter/contracts and hosted private bucket/size/MIME readback; actual object/API qualification pending. | Private buckets are provisioned/read back; supply server credentials and verify real provider hashes, metadata, resumability, expiry/revocation, orphan cleanup and DELETE-plus-absence behavior. |
| SP07 | Completed durable PostgreSQL jobs/outbox/leases and authenticated private-inference boundary; configuration/verification pending. | Select/qualify the actual private inference runtime, configure secrets/endpoints and maintenance scheduler, then verify hosted leases, retries, holds, dead letters and alarms. Matching must create zero recipient access. |
| SP08 | Completed Kotlin/Swift/operator Edge-prefix/API adaptation; verification/configuration pending. | Supply verified release URLs/policy/store/push/link inputs, inspect signed artifacts and exercise all three consumers against the exact hosted environment. No secret/service key enters a client. |
| SP09 | Completed PostgreSQL entitlement, outbox/provider-gateway, support/moderation/privacy/export/erasure, refresh cleanup and revocation implementation; final integration/provider/operation pending. | Current backend receipts are reconciled; configure actual store/APNs/FCM credentials and callbacks, deploy the gateway/ledger, provision independent operators and operate hosted review, export, erasure and notification workflows. |
| SP10 | Current-source PostgreSQL/role/concurrency/Deno proof obtained; hosted verification pending. | Current-source replay is reconciled; run two-account Android/iOS hosted journeys, real Storage/provider failures, security/advisor, capacity, retention and backup/restore checks on the selected project. |

## Private model runtime and operations

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| B01 | Verification pending, conditional on retaining the canonical container path. | Rerun all 27 named glibc fixtures/variants and ABI/package hashes under a faithful x86 Linux kernel. Rosetta and user-mode QEMU do not close the allocator fixture gap. Explicitly qualify a replacement if that runtime is retired. |
| B02 | Verification/configuration pending for another expanding container build. | Check the actual Docker backing volume's current capacity or use a qualified runner before resuming. Historical free-space figures are not current proof; preserve unrelated data. |
| B03 | Private HTTPS service/auth boundary implemented; final canonical runtime/image qualification pending. | Finish nonroot/read-only/egress controls, model/license/dependency/hardening/readiness checks and immutable image/runtime identity. The 23 local model/service-auth tests do not establish a final accepted image. |
| B04 | Verification pending. Existing local native and host-model journeys are retained within their own source scope. | Run complete Android/Swift sharing against the exact accepted private runtime through Supabase API/database/Storage/jobs; retain actual device and hosted results separately. |
| B05 | Deployment package/examples prepared; approved v7+v8 schema applied/read back. API/supporting services not deployed. | Supply real database/Storage/auth/media/maintenance/refresh-encryption secrets, policy/model versions, inference and push hosts, provider settings and scheduler; reconcile CLI migration history and complete the reviewed runtime deployment package before execution. |
| B06 | Verification pending; no hosted deployment occurred. | Exercise the actual deployed API/auth/database/Storage/jobs, alarms/retention, health/readiness and fault recovery with two controlled accounts on Android/iOS. Configuration presence is insufficient. |
| B07 | Operator/security controls and operating-plan drafts implemented; operational configuration/verification pending. | Independently provision authorized operators; name support/moderation/privacy/incident owners, configure monitoring/cost/rotation and backups, and rehearse restore/retention/rollback on the hosted stack. |
| B08 | Resource/authority bounds retained; capacity qualification pending. | Use representative controlled workloads to measure matching/review/concurrency, batching/indexing, cold starts and timeouts. Owner-confirmed absence of real customers is not load-test evidence. Preserve truthful limit errors. |
| B09 | Completed live operator UI/API and durable auth delivery/cancellation; 107/107 local integrated tests passed. Provisioning/hosted/operation pending. | Provision an independent face-authorized admin; qualify real browser camera/encrypted device storage, fresh action authority, revisions, original-key retry, audit and support/privacy/moderation operation against the hosted service. |

## Authentication, recovery and capture

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| A01 | Completed durable enrollment/lost-refresh recovery on original account/key; backend/operator/Swift checks and combined native builds passed within stated checkpoint scope. | Preserve the source-bound receipts, complete final corrected-source physical retakes, then exercise physical storage/lifecycle faults, lost refresh/start/capture/completion replies, retired-delivery cancellation and hosted original-account recovery. |
| A02 | Completed saved-backup plus fresh-face account recovery and Supabase port; verification pending. | Qualify actual secure storage, reinstall/new-device and off-device backup recovery, lost replies and old-session/device revocation against the hosted verifier. No OTP/public-face-search substitute. |
| A03 | Completed face-profile replacement, pause/removal, separate authentication withdrawal/restoration and cleanup port; verification pending. | Verify physical/hosted reference retirement, uncertain cleanup, writer fences and actual object absence; prove former recipient grants never revive. |
| A04 | Completed initialization/permission/interruption, local Use photo/Retake and quality-rejection recovery; verification pending. | Run actual Camera2/AVFoundation permission, Settings return, orientation/mirroring, capture expiry and interruption/storage faults on physical devices against the hosted verifier. |
| A05 | Evaluation runbook/tooling guidance corrected; 23 local model/service-auth tests passed. Representative operating evaluation remains incomplete. | Run separate three-selfie consistency, fresh authentication and photo matching evaluations using consented representative calibration/held-out data; review thresholds, errors/fairness, monitoring and rollback, and supply the strict-mode report/digest. No synthetic/hash pass is operating qualification. |
| A06 | Verification pending. Single-use signed challenges/current-authority checks remain implemented. | Run real physical enrollment/fresh-login/revocation/replay/expiry/failure/account-cleanup acceptance. Do not claim civil identity, liveness or camera-sensor attestation. |

## Connected native experience

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| U01 | Connected UI refinements implemented; current schema3 Pixel normal and font2 full-scroll fixture matrices both passed48/48. Current landscape, iOS runtime, final visual/connected/spoken accessibility acceptance remain pending. | Seal the UI owner's corrected-source reruns, then compare matched Android/iOS viewports, safe areas and real connected states against supplied Lovelies references and the sole design authority. Fixture passes do not establish connected journeys or iOS runtime acceptance. |
| U02 | Completed release/reference separation and fixture-resource exclusions. | Inspect the exact signed store artifacts and release launch/navigation paths for absent fixture photos/catalog/debug entrypoints and truthful progress states. |
| U03 | Completed Android cursor pagination and preserved iOS paging; search generations/cursor ownership fixed. | Verify ordering/new content, errors, refresh, geometry/selection and loaded-page behavior through the exact hosted API and supported native lifecycle paths. |
| U04 | Completed existing source/query controls, iOS orientation mapping and distinct reachable Received / To review journeys on both platforms; final integration/acceptance pending. | Verify current source/query restoration, received access versus contributor proposals, complete-query pagination, clear/no-result and loaded select-all behavior against hosted data. Favorites remain scoped to loaded authorized pages; no new orientation/sort UI or donor destination is required. |
| U05 | Completed viewer paging/zoom/chrome, accessible actions and iOS density/window/dismissal refinements. | Qualify gesture arbitration, anchors, enlargement, accessible alternatives and actual window/device geometry on both native platforms. |
| U06 | Completed account-scoped route/search/filter/favorites/viewer/scroll restoration. | Verify rotation/resizing/background/process restoration, account switch and unavailable restored assets on devices; no recovered UI value may grant access. |
| U07 | Completed persisted review selections/exclusions with fresh-snapshot intersection and fresh preview before commit. | Exercise actual restart, global toggles/filters and changed/revoked candidates; prove excluded pairs remain excluded and restored drafts do not expand authority. T03 upload recovery remains separately retained. |
| U08 | Completed outgoing history and current receipt consumers distinct from the incoming inbox. | Verify hosted partial/requested/accepted/available/revoked states and last-result recovery. Do not label a request/acceptance as proof of device save or viewing. |
| U09 | Completed native support creation/status/history and operator review consumers. | Operate the actual support workflow and verify denied/conflicting/interrupted requests against hosted APIs. Keep retired photographer/professional application flows absent. |
| U10 | Explicit empty/error/unavailable/stale-preview/partial/reconciliation states implemented; complete matrix verification pending. | Execute changed grant/profile/recipient, zero subset, stale manifest and ambiguous retry cases on both connected apps; require zero unauthorized or excluded grants. |

## Media and transfers

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| T01 | Completed durable resumable upload port/journals; verification pending. | Qualify actual hosted accepted-byte/hash/chunk/finalization/status recovery with interrupted storage/network and native process death. Preserve original ownership and operation keys. |
| T02 | Completed bounded Android WorkManager and opportunistic iOS BGProcessingTask retries. | Verify real OS scheduling, expiration/cancellation, lock/reboot/low-power/network/storage behavior and foreground handoff. No continuous force-quit/closed-app completion guarantee is made. |
| T03 | Completed ordered selections/deselections/caption/batch/source/asset recovery retained. | Reverify account/device/original-key integrity under final Supabase transport, partial outcomes and physical storage/provider faults; do not reopen existing local recovery as missing. |
| T04 | Completed truthful selected-picker wording and provider/Files source handoffs; verification pending. | Test full/selected/denied/revoked access, Settings return, changed/cloud-only/inaccessible originals and mid-transfer permission loss on actual Photos/Files/Android providers. |
| T05 | Completed protected staging, bounded preview/share cleanup and account/session retirement fences. | Qualify physical storage faults/expiry/denial/revocation/deletion and account switches; verify cleanup preserves active durable work and cached media cannot bypass current authorization. |
| T06 | Bounded decoding/original format handling implemented; fidelity/performance verification pending. | Test real JPEG/PNG/WebP preservation, labelled iOS HEIC-to-JPEG copies, RAW/animated rejection, EXIF/mirroring/color/HDR/panoramic/large assets and memory behavior on actual providers/devices. |
| T07 | Completed authorized original Save/Share on both platforms with current grant/entitlement checks. | Verify real MediaStore/Photos writes, permission denial/cancellation, unchanged original bytes, temporary grants/cleanup and actual share-sheet behavior on devices. |
| T08 | Current resumable paths retain bounded JPEG/PNG/WebP; compatibility verification pending. | Reconcile any retained legacy GIF/whole-source admission with the actual selected processor and test supported-format round trips. Do not silently promise unchanged bytes for an explicitly converted upload. |

## Purchases, notifications and links

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| P01 | Completed Play Billing/StoreKit loading, purchase/restore and backend verification consumers. | Verify actual product/offer eligibility, pending/cancel/failure/restore/expiry/revoke and interrupted-original resumption with store tests; only server-confirmed production entitlement grants originals. |
| P02 | Configuration/verification pending; source product identity retained. | Both monthly products/pricing and the old Google RTDN/OIDC receiver are read back; Apple availability41/175 and Google175 require intended-market review. Qualify actual provider credentials/cutover/account binding; run actual sandbox renewal/refund/revocation/replay cases without production access from sandbox receipts. |
| P03 | Completed APNs/FCM permission, token binding/rotation/removal and authenticated routing consumers. | Firebase Lovelies client registration/configuration and FCM HTTP v1 enablement are read back in approved existingeasymoai; qualify shared-key restrictions/private sender auth and APNs configuration/signing, then test real device registration/rotation/permission-off/logout plus delivery and tap routing. An inbox or token presence is not push delivery. |
| P04 | Completed durable outbox and APNs HTTP/2 / FCM HTTP v1 provider gateway with receipt ledger; 19/19 local tests and six syntax checks passed. Deployment/provider/device acceptance pending. | Configure the real provider keys, service-account/topic/environment and private gateway/ledger host; verify receipts, opt-out/no-device/invalid-token handling and ambiguous-send reconciliation using actual providers and devices. |
| P05 | Completed guarded native link/notification routing; valid local assetlinks/AASA files prepared from observed Play signing certificate and Apple team/bundle. Files are unpublished. | Select/verify the real host and its platform-specific paths, publish/read back association files, qualify Associated Domains/profile signing and physical authenticated taps with deleted/expired/revoked fallbacks. No invented cross-platform marketing-link contract. |

## Privacy, deletion, safety and public support

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| D01 | Prepared complete local policy/support/terms website drafts and native URL properties/links; publication/configuration pending. | Finalize inference operator/location, retention/backup, audience/territory and legal/controller review; operate support, publish the approved edition, and read back the real in-app/store URLs. |
| D02 | Completed native export request/status/one-use grant/document/share delivery and backend port. | Qualify hosted ready/expired/failed/retry paths, exact account/session/request binding, real export Storage retrieval and device destination write/cleanup. |
| D03 | Completed durable registered deletion confirmation/status/restart and PostgreSQL/private Storage cleanup port. | Verify hosted writer/hold/unknown-result retries, actual DELETE-plus-absence and justified retained records; require verified completion before new-account restart. |
| D04 | Completed anonymous deletion/recovery/status retained and ported; verification/operation pending. | Exercise real secure-storage restart, same-account rejected/expired resume and verified cleanup with an independent hosted operator workflow before enrollment. |
| D05 | Completed local external deletion page with normal email request and no installation/sign-in requirement. | Approve/publish the page, test the real mailbox and proportionate ownership workflow, and confirm Google Play's actual linked public resource. Local 95-link/HTTP/browser checks do not prove request handling. |
| D06 | Completed report/block and authenticated support/moderation consumers. | Staff and verify objectionable-content/incorrect-match response, independent review, holds/revocation and accessible support operation against hosted services. |
| D07 | Complete source-based store privacy/data-safety worksheet and separate-purpose draft prepared; console/configuration/approval pending. | Approve actual audience/markets/retention/processors, qualify the existing Apple 13+ and non-trader declarations, and reconcile published notices and both console forms with final SDK/deployed collection/sharing behavior. |

## Native release artifacts

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| N01 | Completed iOS test target/scheme; final unsigned Release/Debug build-for-testing and 665 Swift host checks passed. Device/signing execution pending. | Final source-bound builds are recorded; execute supported simulator/device tests; qualify production capabilities/profile/archive and store validation. The QA-only development-signed Debug copy does not close these gates. |
| N02 | Completed existing-ID/candidate-version/endpoint implementation, both console histories and local signing readback. | Refresh observed maxima (Play 16 / Apple 14) immediately before using candidate 18; supply final policy/provider inputs and inspect actual signed artifacts, including the Play highest-code/certificate gates. |
| N03 | Matching Play upload key verified and privately copied with restrictive permissions; Gradle has certificate/highest-code gates. Apple team/distribution profile and paired-iPhone development identity inspected; QA-only Debug signed. No signed store artifact accepted. | Supply final release configuration, create/qualify the Apple production APNs/Associated Domains profile, then produce and validate the signed AAB and distribution archive; test actual in-place updates. Never substitute the QA-only profile or debug signing. |
| N04 | Completed real iOS 1024px AppIcon pixels and Android launcher resources. | Inspect final release resource/icon packaging and safe-area rendering; capture actual required store screenshots/feature graphic from the exact candidate with authorized assets. |
| N05 | Privacy manifest, permissions, production APNs entitlement, link configuration and local association files implemented; current Apple profiles lack required production push capability. | Obtain the matching production capability/profile, publish/verify association files and audit final signed privacy/API-reason/SDK notices, encryption/export classification and actual provider behavior/disclosures. |
| N06 | Verification pending for final signed artifacts. | Check final AAB/APK ELF LOAD/RELRO and ZIP alignment, then run a real 16 KiB-supported runtime. Earlier Debug layout and existing live app's Play support label do not certify the replacement. |
| N07 | Android API 36 and current iPhoneOS SDK compilation passed within the final native builds. | Validate final target-API behavior, dependency/toolchain/SDK notices and actual signed upload acceptance; resolve device/store-specific errors from the submitted candidate. |

## Accessibility, resilience and performance

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| Q01 | Shared semantics, targets, headings and gesture alternatives implemented; Pixel 48/48 normal-font initial viewports passed. Ten initial landscape accessibility failures are preserved; corrections/retest pending. | Finish the corrected-source landscape/scroll scanner, then observe spoken TalkBack/VoiceOver, announcements/dialog focus, contrast and connected journeys. Android tree checks and iOS unsigned builds do not substitute for screen-reader/device acceptance. |
| Q02 | Plurals/static-resource extraction and scalable controls improved; complete localization remains open. | Finish remaining hardcoded dynamic/status/error copy, choose supported locales/translations and test long names, singular/plural and enlarged/Dynamic Type across actual routes. |
| Q03 | Reduced-motion/window refinements implemented; initial font-scale-2 test-hook crash preserved and fixed in source, with landscape corrections/reruns pending. | Pass final enlarged-text, landscape and scroll-reachable scans after the freeze; qualify motion/haptics, keyboard/safe areas, tablets/foldables and iOS Dynamic Type/window behavior on running devices. |
| Q04 | Verification pending. Host crypto/model tests and packaged native apps are available. | Run real Camera2/AVFoundation, hardware-protected Keystore/Keychain/signing, front orientation/quality, provider/cloud media and actual save/share checks on physical devices. |
| Q05 | Durable refresh delivery/logout cancellation added to existing journal/fence/interruption protections; backend/operator and Swift affected checks passed. Combined156-case Android/current backend checks pass; final corrected-source device matrix pending. | Finish final corrected-source device retakes, then exercise process death, write/clear failures, offline/low-memory/permission/session/device/consent/block/partial operations on devices; retain failures and zero unauthorized/excluded grants. |
| Q06 | Verification pending; no measured release device budget claimed. | Measure cold/warm startup, gallery frame misses, viewer decode/cache/memory, transfer responsiveness and 10,000-plus assets on the specified device tiers using the exact release candidate. |
| Q07 | Earlier UI-freeze native builds passed; current schema-v8/refresh/push/operator affected checks passed within their stated scope. Current combined native/current-PG proof recorded; final corrected-source physical retakes and hosted journey pending. | Final UI correction/build receipts are sealed; retain corrected-failure history, review dependencies/security and run two-account cross-platform hosted enrollment/review/acceptance/media/entitlement/privacy/revocation regression. |

## Store preparation, submission and rollout

| ID | Current disposition | Concrete remaining gate and input/action |
|---|---|---|
| S01 | Existing Play and Apple app/team/release/upload histories observed; Play signing continuity verified. Both store sessions are restored in Codex; both existing monthly products are verified. The owner completed Program License review; original blocker cleared/Free Apps Active. Paid Apps is Active with New Agreement Available. | Review current paid terms and qualify release/billing/trader/territory permissions and refresh upload histories before action. Preserve both existing listings. |
| S02 | Store name/copy/release-note and public-site drafts prepared; final assets/URLs pending. | Approve actual product copy/category, capture exact release screenshots/icons/Play feature graphic/notices, and publish verified support/privacy/terms/deletion routes. |
| S03 | Source-based privacy/data-safety worksheet, manifest and revised store-copy drafts prepared; no console declarations submitted. | Resolve processors/retention/audience and final SDK/artifact audit; replace inaccurate on-device-only/phone-code reviewer claims, then review Apple App Privacy, Google Data Safety, ratings/access/trader/territory and encryption answers. |
| S04 | Verification/configuration pending; no accepted reviewer-access arrangement. | Prepare an authorized enrollment/review/demo workflow that works with the reviewer's own capture, exact private sharing and purchases; keep qualified backend available without bypassing production grants or exposing real users. |
| S05 | Verification/configuration pending; no TestFlight/Play testing of signed replacement artifacts. | Upload through authorized existing records to applicable testing tracks, exercise clean/in-place installs, sandbox restore and physical paths, and fix actual review/prelaunch/crash feedback. |
| S06 | CI/lockfiles/source-freeze/operating-plan preparation and local canonical source commit completed; no remote or CI execution. | Retain the local canonical source commit, configure the intended remote and run pinned CI; bind final backend/native/model/artifact receipts, and assign/rehearse support/incident/retention/rollback operation. A workflow file or local build is not a GitHub pass. |
| S07 | Verification/approval pending; readiness execution is already authorized. | Finish required gates and present the concrete exact-version release/evidence/rollout package for final owner review and gated deployment/upload/submission authorization. Do not repeat implementation authorization. |
| S08 | Deployment/upload/submission not performed; verification/configuration pending. | After readiness and applicable authorization, deploy/verify the actual Supabase/private-inference/provider stack, upload signed updates to existing store records, complete declarations/review notes, submit and handle review findings. |
| S09 | Verification/operation pending; no replacement public rollout observed. | Run staged/phased rollout with compatible backend, verify actual store installs/updates and operational metrics/support/notifications/rollback triggers, then close the observation window before R12 retirement. |

## Integration checkpoint

All **90 original IDs** appear exactly once above, in the original order. Root
owns the final combined native/backend receipts, source/CI seal and aggregate
checkpoint; the UI owner retains failed and final QA records. The original R1
lost-refresh gap has completed local implementation across the backend and three
consumers, with affected and combined results described above; final corrected-source physical retakes and hosted qualification remain.

The remaining release inputs are the runtime configuration and deployment after the approved schema/readback; real private Storage, scheduler, inference and
provider credentials/hosts; qualified canonical runtime and representative model
evaluation; final corrected-source device/upgrade/performance/
accessibility acceptance; production Apple capabilities/profile and exact signed
store artifacts; operational support/privacy/backup/monitoring; approved and
published policies/association files/assets, final disclosures and reviewer access;
and authorized submission/rollout. Store identity/history and the matching Play
upload key are observed inputs, with history rechecked immediately before upload.
These are existing obligations, not additional features. This reconciliation made
no app-code, donor, production-data, store-record or hosted-service changes.
